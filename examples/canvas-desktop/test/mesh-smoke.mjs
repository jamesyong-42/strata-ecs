/**
 * Mesh smoke — two real tsnet nodes on the real tailnet, exercising exactly the truffle surface
 * `src/mesh.mjs` depends on. This is the gate for a truffle version bump.
 *
 * It exists in the repo on purpose. The previous version of this test lived in a scratch directory,
 * which meant that by the time the next bump came round there was nothing left to run.
 *
 * Covers, in order: createMeshNode → discovery via getPeers/onPeerChange → QUIC listen/connect and a
 * bidirectional framed exchange over a stream → UDP datagram with the peer-identity gate →
 * clean stop(). If a bump breaks the bridge, it breaks here.
 *
 *   node test/mesh-smoke.mjs          # needs TS_AUTHKEY in ../.env (or the environment)
 *
 * Skips with exit 0 when no auth key is present, so it is safe to wire into a CI job that has no
 * tailnet credentials.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ID = "strata-collab-smoke"; // NOT the app's own id — never collide with a live session
const QUIC_PORT = 9440;
const UDP_PORT = 9441;
const DISCOVERY_GRACE_MS = 45_000;

let step = 0;
const log = (m) => process.stdout.write(`[mesh-smoke ${++step}] ${m}\n`);
const fail = (m) => {
  process.stderr.write(`\n✗ ${m}\n`);
  process.exit(1);
};

function authKey() {
  if (process.env.TS_AUTHKEY) return process.env.TS_AUTHKEY;
  const envFile = join(HERE, "..", ".env");
  if (!existsSync(envFile)) return undefined;
  const m = /^TS_AUTHKEY=(.+)$/m.exec(readFileSync(envFile, "utf8"));
  return m?.[1].trim();
}

const key = authKey();
if (!key) {
  process.stdout.write("[mesh-smoke] SKIP — no TS_AUTHKEY (set it in ../.env or the environment)\n");
  process.exit(0);
}

const deadline = (ms, what) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms ${what}`)), ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy, or throw at the grace deadline. */
async function until(fn, ms, what) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(500);
  }
}

const dirs = [];
/**
 * Rejects fast and specifically when the auth key is refused. tsnet does not fail in that case — it
 * drops to NeedsLogin and waits on interactive browser login, which from a script looks exactly like
 * a network hang until the 90s deadline. `onAuthRequired` is the signal that distinguishes them.
 */
let authRejected;
const authFailure = new Promise((_, rej) => {
  authRejected = () =>
    rej(
      new Error(
        "tailscale rejected the auth key (tsnet fell back to interactive login).\n" +
          "    Generate a fresh key at https://login.tailscale.com/admin/settings/keys and put it in\n" +
          "    examples/canvas-desktop/.env as TS_AUTHKEY=…  — note single-use keys are consumed by\n" +
          "    the first run, and this smoke starts TWO nodes, so it needs a REUSABLE key.",
      ),
    );
});

async function node(name) {
  const { createMeshNode } = await import("@vibecook/truffle");
  const stateDir = mkdtempSync(join(tmpdir(), `mesh-smoke-${name}-`));
  dirs.push(stateDir);
  const events = [];
  const mesh = await createMeshNode({
    appId: APP_ID,
    deviceName: `smoke-${name}-${process.pid}`,
    stateDir,
    authKey: key,
    ephemeral: true, // leave the tailnet on stop — never accumulate ghost nodes
    onAuthRequired: () => authRejected(),
    openUrl: () => {}, // never pop a browser from a test run
    onPeerChange: (ev) => events.push(ev),
  });
  return { mesh, events, name };
}

let a, b;
try {
  log("starting two ephemeral tsnet nodes…");
  [a, b] = await Promise.race([
    Promise.all([node("a"), node("b")]),
    authFailure,
    // By far the most common cause, and it does NOT surface as an error: tsnet drops to NeedsLogin
    // and waits on interactive browser login, which from a script is indistinguishable from a
    // network hang. (`onAuthRequired` is not reliably invoked on this path, so the hint lives here.)
    // The sidecar's own stderr gives it away — "LocalBackend state is NeedsLogin".
    deadline(
      90_000,
      "for both nodes to reach Running.\n" +
        "    If the sidecar logged \"NeedsLogin\", the auth key was REJECTED — expired, or single-use\n" +
        "    and already consumed. Generate a REUSABLE key (this starts two nodes) at\n" +
        "    https://login.tailscale.com/admin/settings/keys and set TS_AUTHKEY in\n" +
        "    examples/canvas-desktop/.env",
    ),
  ]);
  const aId = a.mesh.getLocalInfo().tailscaleId;
  const bId = b.mesh.getLocalInfo().tailscaleId;
  if (!aId || !bId) fail("getLocalInfo().tailscaleId is empty — identity is the routing key");
  log(`up: a=${aId.slice(0, 12)}… b=${bId.slice(0, 12)}…`);

  log("waiting for mutual discovery…");
  const bFromA = await until(
    async () => (await a.mesh.getPeers()).find((p) => p.tailscaleId === bId && p.online && p.ip),
    DISCOVERY_GRACE_MS,
    "a to see b online with an address",
  );
  await until(
    async () => (await b.mesh.getPeers()).find((p) => p.tailscaleId === aId && p.online && p.ip),
    DISCOVERY_GRACE_MS,
    "b to see a online with an address",
  );
  if (!bFromA.ip) fail("Peer.ip is empty for an online peer — the dial side depends on it");
  log(`discovered: b.ip=${bFromA.ip}, displayName=${bFromA.displayName}`);
  if (a.events.length === 0) fail("onPeerChange never fired on a");
  log(`onPeerChange fired ${a.events.length}x on a (types: ${[...new Set(a.events.map((e) => e.type))].join(",")})`);

  // ---- QUIC: b listens, a dials, framed bytes both directions -------------------------------
  log("QUIC: listen / connect / bidirectional stream…");
  const server = await b.mesh.quic.listen(QUIC_PORT);
  const echoed = (async () => {
    const conn = await server.accept();
    if (!conn) throw new Error("server.accept() returned null");
    for await (const stream of conn.streams()) {
      for await (const chunk of stream) {
        stream.write(Buffer.concat([Buffer.from("echo:"), chunk]));
      }
      return;
    }
  })();

  const conn = await Promise.race([
    a.mesh.quic.connect(bFromA, QUIC_PORT),
    deadline(30_000, "dialling b over QUIC"),
  ]);
  const stream = await conn.openStream();
  const payload = Buffer.from("strata-mesh-smoke");
  stream.write(payload); // streams are lazy — the peer sees one only after the first write
  const reply = await Promise.race([
    new Promise((res) => stream.once("data", res)),
    deadline(30_000, "for the QUIC echo"),
  ]);
  const want = `echo:${payload}`;
  if (String(reply) !== want) fail(`QUIC echo mismatch: got ${JSON.stringify(String(reply))}, want ${JSON.stringify(want)}`);
  log(`QUIC round-trip ok (${reply.length} bytes)`);
  stream.destroy();
  conn.close();
  server.close();
  await echoed.catch(() => {});

  // ---- UDP: datagram + the peer-identity enrichment the inbound gate relies on ---------------
  log("UDP: bind / send / receive with peer identity…");
  const aSock = a.mesh.dgram.createSocket();
  const bSock = b.mesh.dgram.createSocket();
  await aSock.bind(UDP_PORT);
  await bSock.bind(UDP_PORT);
  const got = new Promise((res) => bSock.once("message", (msg, rinfo) => res({ msg, rinfo })));
  aSock.send(Buffer.from("ping"), UDP_PORT, bFromA.ip, () => {});
  const { msg, rinfo } = await Promise.race([got, deadline(30_000, "for the datagram")]);
  if (String(msg) !== "ping") fail(`datagram payload mismatch: ${String(msg)}`);
  if (!rinfo.address) fail("rinfo.address empty — the inbound gate falls back to source IP");
  log(`UDP ok: "${msg}" from ${rinfo.address} (peerId=${rinfo.peerId ?? "undefined — gate falls back to IP"})`);
  aSock.close();
  bSock.close();

  log("stopping both nodes…");
  await Promise.race([Promise.all([a.mesh.stop(), b.mesh.stop()]), deadline(30_000, "for stop()")]);
  a = b = undefined;

  const truffleVersion = JSON.parse(
    readFileSync(join(HERE, "..", "node_modules", "@vibecook", "truffle", "package.json"), "utf8"),
  ).version;
  process.stdout.write(`\n✓ mesh-smoke PASS — @vibecook/truffle ${truffleVersion}\n`);
} catch (err) {
  process.stderr.write(`\n✗ mesh-smoke FAILED: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  for (const n of [a, b]) if (n) await n.mesh.stop().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
