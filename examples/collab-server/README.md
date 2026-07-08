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

## WebTransport relay (Tier 2)

Alongside the WebSocket relay is an optional **WebTransport relay** (`src/wt-relay.js`) — the
same dumb byte-switchboard, but over **one QUIC connection** per client carrying **two delivery
classes** (see `../canvas-editor/src/collab/transport.ts`, `deliveryClassOf`):

- **reliable-ordered** (`durable` / `hello` / `snapshot`) → one bidirectional **stream**,
- **latest-lossy** (`ephemeral`) → **datagrams**, auto-upgrading to the stream when an envelope
  exceeds the negotiated `maxDatagramSize` (1024 B in Chrome here).

Two differences from the WS relay, both forced by the transport: a QUIC stream is a raw byte
stream, so the relay reads **length-delimited frames** (`[u32-LE len][blob]`) to forward whole
frames without interleaving (it still never looks *inside* a blob); and datagrams are forwarded
verbatim and **dropped, never queued**, under backpressure. Rooms are still the URL path — any
path is accepted via a request-callback that routes every session to one internal stream and
recovers the room from the (rewritten) `:path` header.

```sh
pnpm start:wt        # starts BOTH relays (WS on :8787, WT on :4433) over a shared dev cert
pnpm cert            # print the cert fingerprint + a ready-to-paste client param
node src/wt-relay.js # the WT relay alone (WT_PORT / WT_HOST env overrides)
```

`node src/server.js` is **unchanged** — WS-only, no cert, no native dependency on its path. The
WebTransport relay needs TLS: `src/certs.js` mints an ephemeral 13-day ECDSA cert (via the
vendored upstream generator `src/certificate.js` — openssl's ECDSA PEM does not parse in quiche),
caches it to the gitignored `.wt-cert.json`, and prints the SHA-256 hash the browser pins with
`serverCertificateHashes`. `pnpm start:wt` prints the exact `?collab=demo&wt=…&certHash=…` param.

> **Demo only — do not expose publicly.** There is no authentication, no authorization, and no
> rate limiting. The WS relay has no TLS; the WT relay's pinned-hash cert is a demo escape hatch
> from a real PKI (short-lived certs, no CA), **not** a production posture. Anyone who can reach
> the port can join any room and read/write every byte in it. For anything beyond a LAN demo, put
> it behind your own authenticated transport — the framework only needs *some* channel that moves
> bytes per-peer in order.
