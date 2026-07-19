/**
 * The wire — framing, the four message kinds, and the convergence digest. Shared by host + client.
 *
 * FRAMING (honest and tiny): every message is one BINARY WebSocket frame. Byte 0 is a 1-byte kind tag;
 * bytes 1.. are the CRDT payload (empty for `hello`). No JSON header, no length prefix — the frame IS the
 * length. `ws` delivers a Node Buffer; we copy the payload out into a detached Uint8Array before handing
 * it to Loro (`ws` recycles its receive buffers).
 *
 *   hello    client → host   on connect. No payload.
 *   snapshot host → client   the host's whole converged document (`store.exportSnapshot()`); the joiner
 *                            imports it as its causal base, then it is bootstrapped.
 *   base     client → host   the joiner's OWN `store.exportSnapshot()` after importing the host snapshot
 *                            (THE BIDIRECTIONAL LAW — see host.mjs / README). The host absorbs it
 *                            idempotently AND relays it to the other clients so a peer that predates the
 *                            joiner learns its construction commit and won't quarantine on its increments.
 *   update   both directions one sealed commit (`subscribeOutbound` bytes). `applyRemote`'d on receipt and
 *                            relayed to the room's OTHER clients.
 */

export const KIND = Object.freeze({ hello: 1, snapshot: 2, base: 3, update: 4 });
const KIND_NAME = Object.freeze({ 1: "hello", 2: "snapshot", 3: "base", 4: "update" });

/** Frame `payload` (a Uint8Array, or undefined for a payload-less kind) as `[kind, …payload]`. */
export function frame(kind, payload) {
  const len = payload ? payload.byteLength : 0;
  const out = Buffer.allocUnsafe(1 + len);
  out[0] = kind;
  if (len) Buffer.from(payload.buffer, payload.byteOffset, len).copy(out, 1);
  return out;
}

/** Decode a received binary frame into `{ kind, kindName, payload }`; payload is a fresh, detached copy. */
export function unframe(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const kind = buf[0];
  // Copy the payload out of ws's recycled receive buffer into memory Loro can hold onto.
  const payload = buf.byteLength > 1 ? Uint8Array.prototype.slice.call(buf, 1) : new Uint8Array(0);
  return { kind, kindName: KIND_NAME[kind] ?? `?${kind}`, payload };
}

// --- the convergence digest ---------------------------------------------------------------------------
// A small reimplementation of the canvas-editor swarm-probe oracle: walk the converged DOCUMENT (not the
// runtime) — `store.snapshot.entities()` + `readEntity` — into a canonical per-entity string, and fold an
// order-normalized FNV-1a hash over the whole set (keys sorted before an order-dependent fold). Every
// party stores byte-identical converged cells, so
// two parties that have converged produce the same digest. Reads the document directly, so it needs no
// `world.sync()`. `store.snapshot` is the same adapter accessor the swarm-probe uses.

/** Deterministic stringify: recursively sort object keys so key order can't perturb the digest. */
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(",")}}`;
}

/** FNV-1a 32-bit → 8 hex chars. Cheap, order-sensitive, plenty for an equality digest. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");

/** `{ digest, entityCount }` over a store's converged document — equal iff the documents converged. */
export function documentDigest(store) {
  const snap = store.snapshot; // the converged-document adapter (see swarm-probe.ts)
  const keys = [...snap.entities()].map(String).sort();
  let acc = 0x811c9dc5;
  let entityCount = 0;
  for (const key of keys) {
    const rec = snap.readEntity(key);
    if (rec === undefined) continue; // entities() already gates on hasEntity; defensive
    entityCount++;
    const comps = Object.keys(rec.components)
      .sort()
      .map((c) => `${c}=${stable(rec.components[c])}`)
      .join(",");
    const tags = [...rec.tags].sort().join(",");
    const rels = Object.keys(rec.relations)
      .sort()
      .map((r) => {
        const t = rec.relations[r];
        const arr = Array.isArray(t) ? [...t].map(String).sort() : [String(t)];
        return `${r}=[${arr.join(",")}]`;
      })
      .join(",");
    acc ^= fnv1a(`${key}|c{${comps}}|t{${tags}}|r{${rels}}`);
    acc = Math.imul(acc, 0x01000193);
  }
  return { digest: hex(acc), entityCount };
}

// --- a tiny polling await -----------------------------------------------------------------------------

/**
 * Resolve with the first truthy value `fn()` returns, polling every `intervalMs`; reject after `timeoutMs`.
 * The example's stand-in for "wait until the room quiesces / converges" without wiring an event bus.
 */
export function poll(fn, { timeoutMs = 8000, intervalMs = 25, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      let v;
      try {
        v = await fn();
      } catch (err) {
        reject(err);
        return;
      }
      if (v) {
        resolve(v);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`poll timed out after ${timeoutMs}ms waiting for ${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
