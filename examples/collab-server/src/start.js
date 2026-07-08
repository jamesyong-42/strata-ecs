/**
 * The combined collab launcher: start BOTH relays at once — the WebSocket relay (src/server.js, the Tier-1
 * fallback) and the WebTransport relay (src/wt-relay.js, the Tier-2 dual-class transport) — over a shared
 * dev cert (src/certs.js). Run with `pnpm start:wt` (or `node src/start.js`).
 *
 * `node src/server.js` is DELIBERATELY left as WS-only (no cert, no native quiche dep on the hot path) so
 * the minimal demo still runs with just `ws`. This launcher is the opt-in that adds WebTransport alongside.
 *
 * Env overrides: PORT / WS_PORT (WS, default 8787), WT_PORT (WT, default 4433), WT_HOST (default 127.0.0.1).
 * It prints a ready-to-paste client URL for each transport so two browser tabs can be pointed at either.
 */

import { startRelay } from "./server.js";
import { startWtRelay } from "./wt-relay.js";
import { loadOrCreateCert, clientParamFor } from "./certs.js";

const wsPort = Number(process.env.WS_PORT ?? process.env.PORT ?? 8787);
const wtPort = Number(process.env.WT_PORT ?? 4433);
const wtHost = process.env.WT_HOST ?? "127.0.0.1";

const cert = await loadOrCreateCert();

// WS relay (unchanged behavior — the same dumb byte-relay src/server.js exposes).
const wss = startRelay(wsPort);
await new Promise((res) => wss.on("listening", res));

// WT relay (dual-class over one QUIC connection).
const { close: closeWt } = await startWtRelay({
  port: wtPort,
  host: wtHost,
  cert: cert.cert,
  privKey: cert.privateKey,
});

console.log("");
console.log(
  `[collab] WebSocket relay:    ws://localhost:${wsPort}   (rooms by URL path, e.g. /demo)`,
);
console.log(`[collab]   → browser param:  ?collab=demo&ws`);
console.log(
  `[collab] WebTransport relay: https://${wtHost}:${wtPort}   (rooms by URL path, e.g. /demo)`,
);
console.log(`[collab]   → cert hash:      ${cert.hashHex}`);
console.log(
  `[collab]   → browser param:  ?collab=demo&wt=https://${wtHost}:${wtPort}&${clientParamFor(cert)}`,
);
console.log("");

const shutdown = () => {
  console.log("[collab] shutting down");
  try {
    closeWt();
  } catch {
    /* already stopped */
  }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
