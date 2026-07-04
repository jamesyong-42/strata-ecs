/**
 * The strata-ecs collab relay — a DUMB WebSocket byte-relay for the canvas-editor demo.
 *
 * What it IS: a room switchboard. A client connects to `ws://host:port/<room>` (the room is the URL
 * path); the relay broadcasts every frame it receives to the OTHER sockets in that same room, verbatim.
 *
 * What it deliberately is NOT: it never decodes a frame (the header/payload layout in transport-ws.ts is
 * none of its business), holds NO document state, runs NO CRDT, and resolves NO conflicts. Peers bootstrap
 * each other over the app's own hello→snapshot protocol; convergence is the framework's, behind
 * `doc.applyRemote`. Per-connection WebSocket ordering is the per-peer causal in-order delivery that
 * strata's 006 §A4 transport addendum requires while a socket is connected; a drop triggers the client's
 * full re-bootstrap (transport-ws.ts + boot.ts), so the relay needs no memory of who saw what.
 *
 * Run: `node src/server.js` (PORT env overrides the default 8787), or `pnpm collab:server` from the repo
 * root. ~100 lines on purpose — the point of the demo is how little the server does.
 */

import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

/**
 * Start the relay on `port`. Returns the `WebSocketServer` (the test starts one on an ephemeral port).
 * Room membership lives only in memory and only for the lifetime of the connections — no persistence.
 */
export function startRelay(port = Number(process.env.PORT ?? 8787)) {
  /** @type {Map<string, Set<WebSocket>>} room name → its currently-connected sockets */
  const rooms = new Map();
  const wss = new WebSocketServer({ port });

  const roomOf = (url) => {
    // ws://host:port/<room>[?…] — the path (minus leading slashes, query stripped) is the room.
    const path = (url ?? "/").split("?")[0].replace(/^\/+/, "");
    return decodeURIComponent(path) || "default";
  };

  wss.on("connection", (socket, req) => {
    const room = roomOf(req.url);
    let members = rooms.get(room);
    if (members === undefined) {
      members = new Set();
      rooms.set(room, members);
    }
    members.add(socket);
    console.log(`[collab-server] + join  room="${room}" (${members.size} in room)`);

    socket.on("message", (data, isBinary) => {
      // The whole job: forward the exact bytes to every OTHER member of the room. Never parse `data`.
      const peers = rooms.get(room);
      if (peers === undefined) return;
      for (const peer of peers) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN)
          peer.send(data, { binary: isBinary });
      }
    });

    const leave = (why) => {
      const peers = rooms.get(room);
      if (peers === undefined) return;
      peers.delete(socket);
      if (peers.size === 0) rooms.delete(room);
      console.log(`[collab-server] - leave room="${room}" (${why}; ${peers.size} left)`);
    };

    socket.on("close", () => leave("close"));
    socket.on("error", (err) => {
      console.warn(`[collab-server] ! socket error in room="${room}": ${err.message}`);
      leave("error");
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    });
  });

  wss.on("error", (err) => console.error(`[collab-server] server error: ${err.message}`));
  return wss;
}

// Run as a binary (`node src/server.js`): start the relay + log lifecycle + handle Ctrl-C cleanly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const wss = startRelay();
  wss.on("listening", () => {
    const { port } = wss.address();
    console.log(
      `[collab-server] dumb byte-relay listening on ws://localhost:${port}  (rooms by URL path, e.g. /demo)`,
    );
  });
  const shutdown = () => {
    console.log("[collab-server] shutting down");
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
