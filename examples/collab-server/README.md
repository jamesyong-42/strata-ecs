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

## Measured: what the second delivery class buys

Both relays ran inside a `tc netem`-shaped Linux container (headless-Chrome peers on the host;
2 reps per cell; the probe drives a cursor at the app's real 30 Hz presence cadence, so **33 ms
between updates is the floor**). Two results, called straight in both directions:

**Presence tail under loss** (2 peers, 1k-entity board, ~64 s steady window — remote-cursor
inter-arrival):

| link | WS p99 / max | WebTransport p99 / max |
|---|---|---|
| clean | **49–50 / 73–82 ms** | 51–55 / 91–153 ms |
| 50 ms delay | 52–58 / 66–68 ms | 57–59 / 67–73 ms |
| 25 ms delay + 1% loss | 50–99 / 109–175 ms | **57–61 / 78–83 ms** |
| 25 ms delay + 3% loss | 101–107 / **341–348 ms** | **67–74 / 92–143 ms** |

On a clean link WS is slightly *tighter* (QUIC datagram scheduling costs a few ms of tail). Under
loss the picture inverts: TCP retransmits stall every queued frame behind the hole, so the WS max
gap balloons to 10× the send cadence, while datagrams just drop the stale frame and carry the next.

**Bootstrap contention** (3 peers, 10k-entity board = 1.84 MB snapshot, 20 mbit + 10 ms link): while
a joiner pulls the snapshot, an unrelated observer's cursor feed stalls **1.9–3.4 s over WS** vs
**~0.5 s over WebTransport** — the snapshot burst saturates the shared queue and the observer's TCP
stream collapses into retransmission, where datagrams degrade to a few lost frames. (The joiner's
own ~16.5 s freeze at 10k entities is the snapshot *import* CPU cost — identical on both
transports, and a framework work item, not a transport one.)

Also measured en route: a fixed hello window breaks bootstrap on slow links — at 20 mbit the
1.84 MB snapshot answer takes ~750 ms and *loses the race* against an 800 ms hello timeout, forking
the joiner. Production apps should scale their bootstrap window with expected snapshot size ÷
bandwidth, or acknowledge the hello before shipping the snapshot.

> **Demo only — do not expose publicly.** There is no authentication, no authorization, and no
> rate limiting. The WS relay has no TLS; the WT relay's pinned-hash cert is a demo escape hatch
> from a real PKI (short-lived certs, no CA), **not** a production posture. Anyone who can reach
> the port can join any room and read/write every byte in it. For anything beyond a LAN demo, put
> it behind your own authenticated transport — the framework only needs *some* channel that moves
> bytes per-peer in order.
