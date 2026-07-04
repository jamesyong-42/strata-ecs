/**
 * Relay round-trip smoke: start the relay on an ephemeral port, connect two clients to one room, and
 * assert a frame from A reaches B verbatim, that A does NOT receive its own frame, and that a client in a
 * DIFFERENT room hears nothing (the room routing). Run with `pnpm --filter @strata-ecs/collab-server test`
 * (i.e. `node --test`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startRelay } from "../src/server.js";

const once = (emitter, event) => new Promise((res) => emitter.once(event, res));
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

test("relay broadcasts a binary frame to the other member of the room only", async () => {
  const wss = startRelay(0);
  await once(wss, "listening");
  const { port } = wss.address();
  const url = (room) => `ws://localhost:${port}/${room}`;

  const a = new WebSocket(url("demo"));
  const b = new WebSocket(url("demo"));
  const other = new WebSocket(url("otherRoom"));
  await Promise.all([once(a, "open"), once(b, "open"), once(other, "open")]);

  const bGot = once(b, "message");
  let aEchoed = false;
  a.on("message", () => {
    aEchoed = true;
  });
  let otherGot = false;
  other.on("message", () => {
    otherGot = true;
  });

  const payload = Uint8Array.from([1, 2, 3, 4, 250]);
  a.send(payload);

  const received = new Uint8Array(await bGot);
  assert.deepEqual([...received], [1, 2, 3, 4, 250], "B receives A's exact bytes");

  await delay(50); // give any (wrong) deliveries a chance to arrive before asserting their absence
  assert.equal(aEchoed, false, "the sender never receives its own frame");
  assert.equal(otherGot, false, "a client in a different room hears nothing");

  for (const s of [a, b, other]) s.close();
  await new Promise((res) => wss.close(res));
});
