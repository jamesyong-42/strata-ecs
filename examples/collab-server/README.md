# @strata-ecs/collab-server

A ~100-line **dumb WebSocket byte relay** for the canvas-editor demo. Clients connect to
`ws://host:8787/<room>`; the relay broadcasts every frame it receives to the *other*
sockets in the same room, verbatim. It never decodes a frame, holds no document state,
runs no CRDT, and resolves no conflicts — peers bootstrap each other over the app's own
hello→snapshot protocol, and convergence is strata-ecs's job behind `doc.applyRemote`.

```sh
pnpm collab:server            # from the repo root — ws://localhost:8787
PORT=9000 node src/server.js  # or standalone, any port
```

Then open two browsers at `http://localhost:5173/?collab=demo&ws` (see
[the example app](../canvas-editor)).

> **Demo only — do not expose publicly.** There is no authentication, no authorization,
> no rate limiting, and no TLS: anyone who can reach the port can join any room and
> read/write every byte in it. For anything beyond a LAN demo, put it behind your own
> authenticated transport — the framework only needs *some* channel that moves bytes
> per-peer in order.
