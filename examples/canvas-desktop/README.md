# canvas-desktop — the canvas-editor as a serverless desktop collab app

The [canvas-editor](../canvas-editor) running in a minimal Electron shell. The renderer is the
unchanged browser app; the desktop shell contributes exactly one thing: **a transport**.

- **P1 (this)** — the Electron main process is a room *switchboard*: every window of the app is a
  collaborator, relayed over IPC. Same contract as the [collab-server](../collab-server) relay:
  payloads are never decoded, no document state, no conflict handling — convergence is the
  framework's job behind `doc.applyRemote`.
- **P2 (next)** — main additionally joins a [truffle](https://github.com/jamesyong-42/truffle)
  mesh (Tailscale tsnet embedded in-process): app instances on other machines discover each other by
  appId on your tailnet and become room members — durable loro sync over raw QUIC streams, presence
  over UDP datagrams. No server anywhere, and no Tailscale install needed: the app itself is the
  tailnet node.

## Run (P1)

```bash
pnpm install               # repo root
pnpm example:canvas        # terminal 1 — the UI dev server (vite, :5173)
pnpm example:desktop       # terminal 2 — the Electron shell
```

**Cmd/Ctrl+N** opens a second window — a second collaborator in the room, converging over IPC with
zero network. `CANVAS_URL` overrides the dev-server origin; `STRATA_ROOM` overrides the room name
(default `demo`).

## How the pieces meet

```
renderer (canvas-editor, unchanged)          main (this package)
  boot.ts picks the channel:                   src/main.mjs — room switchboard
    window.strataDesktop present?  ──────►       members: webContents ↔ {room, peerId}
      └ transport-ipc.ts (Channel)               forwards envelopes, honors `to`-addressing
        via src/preload.cjs (contextBridge;      P2: + truffle mesh node (QUIC/UDP lanes)
        Uint8Array structured-clones)
```

The renderer-side channel lives with its siblings in
`canvas-editor/src/collab/transport-ipc.ts` and satisfies the same `Channel` surface as
BroadcastChannel / the WS relay client / WebTransport — the bootstrap state machine cannot tell the
difference.
