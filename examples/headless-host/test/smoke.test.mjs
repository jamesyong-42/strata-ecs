/**
 * The headless-host smoke — `node --test` (the package "test" script). Three proofs, one host binary
 * spawned as a real child process (the honest test: a separate process, its own schema registry), clients
 * created in-process:
 *
 *   1. CONVERGENCE — two clients join one room, each spawns + edits through `store.transaction`, and both
 *      converge to the same document digest at the expected entity count. A fresh observer then bootstraps
 *      from the host's snapshot and matches — proving the HOST's authoritative state converged too.
 *   2. PERSISTENCE — kill the host, restart it on the same data dir, join a new client: its digest matches
 *      the pre-restart digest (the on-disk snapshot restored).
 *   3. MULTI-WORLD — two rooms run concurrently on one host (two Worlds, one process, the shared
 *      process-global schema) and stay independent.
 *   4. ROBUSTNESS — a malformed update frame (undecodable CRDT bytes) drops only ITS socket: the host
 *      process survives, the room's document is unmutated, and well-behaved clients keep converging.
 *      (loro throws a bare string on garbage — the total-catch law this pins was a review finding.)
 *
 * Kept well under ~20s wall: tiny entity counts, 25ms convergence polls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createHeadlessClient } from "../src/client.mjs";
import { frame, KIND, poll } from "../src/protocol.mjs";
import { Pos, Tint } from "../src/schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = join(HERE, "..", "src", "host.mjs");

/** Spawn the host on an OS-assigned port (PORT=0) with an isolated data dir; resolve its chosen port. */
function startHost(dataDir) {
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, PORT: "0", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[host stderr] ${d}`));
  const port = new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const onExit = (code) => {
      if (!done) reject(new Error(`host exited before ready (code ${code})`));
    };
    // Listener stays attached to keep draining the host's status lines (an unread pipe could stall it).
    child.stdout.on("data", (d) => {
      if (done) return;
      buf += d;
      const m = buf.match(/ready port=(\d+)/);
      if (m) {
        done = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(Number(m[1]));
      }
    });
    const timer = setTimeout(() => {
      if (!done) reject(new Error("host did not report ready within 8s"));
    }, 8000);
    timer.unref?.();
    child.once("exit", onExit);
  });
  return { child, port };
}

/** SIGTERM the host and await its exit (its shutdown flushes every room to disk). Idempotent. */
async function stopHost(h) {
  await h.port.catch(() => {}); // settle the ready promise so it isn't an unhandled rejection
  if (h.child.exitCode !== null || h.child.signalCode !== null) return;
  await new Promise((res) => {
    h.child.once("exit", res);
    h.child.kill("SIGTERM");
  });
}

const urlFor = (port, room) => `ws://localhost:${port}/${room}`;

/** Spawn `n` entities through the transaction API, then edit the first — a real cross-transaction value
 *  write (`sync()` first so its Pos is pre-existing). Returns the spawned handles. */
function authorInto(client, n, x0) {
  const handles = [];
  for (let i = 0; i < n; i++) {
    handles.push(
      client.store.transaction((tx) =>
        tx.spawn({
          components: [
            [Pos, { x: x0 + i, y: i }],
            [Tint, { hue: (x0 + i) % 360 }],
          ],
        }),
      ),
    );
  }
  client.sync();
  client.store.transaction((tx) => tx.edit(handles[0]).set(Pos, { x: x0 + 100, y: 100 }));
  client.sync();
  return handles;
}

test("headless document host", async (t) => {
  const dirSmoke = mkdtempSync(join(tmpdir(), "headless-smoke-"));
  const dirRooms = mkdtempSync(join(tmpdir(), "headless-rooms-"));
  const clients = [];
  const hosts = [];
  const track = (c) => {
    clients.push(c);
    return c;
  };

  let convergedDigest;

  try {
    await t.test(
      "two clients converge; a fresh observer mirrors the host's authoritative state",
      async () => {
        const h = startHost(dirSmoke);
        hosts.push(h);
        const port = await h.port;

        const a = track(createHeadlessClient(urlFor(port, "smoke"), { name: "A" }));
        const b = track(createHeadlessClient(urlFor(port, "smoke"), { name: "B" }));
        await Promise.all([a.ready, b.ready]);

        authorInto(a, 2, 0); // 2 entities from A
        authorInto(b, 2, 500); // 2 entities from B

        const converged = await poll(
          () => {
            const da = a.digest();
            const db = b.digest();
            return da.entityCount === 4 && db.entityCount === 4 && da.digest === db.digest
              ? da
              : null;
          },
          { label: "A and B to converge on 4 entities" },
        );
        convergedDigest = converged.digest;

        // The host included: an observer bootstraps from the host's snapshot; a match proves the host's own
        // authoritative document is the converged one.
        const o = track(createHeadlessClient(urlFor(port, "smoke"), { name: "O" }));
        await o.ready;
        const od = await poll(
          () => {
            const d = o.digest();
            return d.entityCount === 4 && d.digest === convergedDigest ? d : null;
          },
          { label: "the observer to mirror the host's converged state" },
        );
        assert.equal(od.digest, convergedDigest);
      },
    );

    await t.test("state survives a host restart (disk persistence)", async () => {
      await stopHost(hosts[0]); // SIGTERM flushes the room to disk
      const h2 = startHost(dirSmoke);
      hosts.push(h2);
      const port = await h2.port;

      const r = track(createHeadlessClient(urlFor(port, "smoke"), { name: "R" }));
      await r.ready;
      const restored = await poll(
        () => {
          const d = r.digest();
          return d.entityCount === 4 && d.digest === convergedDigest ? d : null;
        },
        { label: "the restarted host to restore the persisted document" },
      );
      assert.equal(
        restored.digest,
        convergedDigest,
        "restored digest must equal the pre-restart digest",
      );
    });

    await t.test("two rooms run as independent Worlds in one process (shared schema)", async () => {
      const h3 = startHost(dirRooms);
      hosts.push(h3);
      const port = await h3.port;

      const alpha = track(createHeadlessClient(urlFor(port, "alpha"), { name: "alpha" }));
      const beta = track(createHeadlessClient(urlFor(port, "beta"), { name: "beta" }));
      await Promise.all([alpha.ready, beta.ready]);

      authorInto(alpha, 3, 0); // 3 entities in room "alpha"
      authorInto(beta, 1, 900); // 1 entity in room "beta"

      const ad = await poll(() => (alpha.digest().entityCount === 3 ? alpha.digest() : null), {
        label: "alpha to hold 3",
      });
      const bd = await poll(() => (beta.digest().entityCount === 1 ? beta.digest() : null), {
        label: "beta to hold 1",
      });

      assert.equal(alpha.digest().entityCount, 3);
      assert.equal(beta.digest().entityCount, 1);
      assert.notEqual(ad.digest, bd.digest, "independent rooms must not share a document");
    });

    await t.test("a malformed frame drops only its socket — the host survives", async () => {
      const h3 = hosts[hosts.length - 1]; // the multi-room host, still up with room "alpha" at 3 entities
      const port = await h3.port;

      // The attacker: a raw socket that skips hello and fires undecodable bytes as base AND update.
      const attacker = new WebSocket(urlFor(port, "alpha"));
      await new Promise((res, rej) => {
        attacker.once("open", res);
        attacker.once("error", rej);
      });
      attacker.send(frame(KIND.update, new Uint8Array([1, 2, 3, 4, 5])), { binary: true });
      attacker.send(frame(KIND.base, new Uint8Array([9, 9, 9])), { binary: true });
      // The host must close the attacker, not itself.
      await poll(() => (attacker.readyState === WebSocket.CLOSED ? true : null), {
        label: "the host to drop the attacker's socket",
      });
      assert.equal(h3.child.exitCode, null, "the host process must survive malformed frames");

      // The room is unmutated and still serves: a fresh client bootstraps to the same 3 entities, and an
      // existing client can still author through it.
      const w = track(createHeadlessClient(urlFor(port, "alpha"), { name: "W" }));
      await w.ready;
      assert.equal(w.digest().entityCount, 3, "garbage import must leave the document unmutated");
      w.store.transaction((tx) => tx.spawn({ components: [[Pos, { x: 77, y: 77 }]] }));
      w.sync();
      await poll(() => (w.digest().entityCount === 4 ? true : null), {
        label: "the room to keep accepting well-behaved writes",
      });
    });
  } finally {
    for (const c of clients) c.close();
    for (const h of hosts) await stopHost(h);
    for (const dir of [dirSmoke, dirRooms]) rmSync(dir, { recursive: true, force: true });
  }
});
