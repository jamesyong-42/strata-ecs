# canvas-desktop — the canvas-editor as a serverless desktop collab app

The [canvas-editor](../canvas-editor) running in a minimal Electron shell. The renderer is the
unchanged browser app; the desktop shell contributes exactly one thing: **a transport**.

- **P1 (this)** — the Electron main process is a room *switchboard*: every window of the app is a
  collaborator, relayed over IPC. Same contract as the [collab-server](../collab-server) relay:
  payloads are never decoded, no document state, no conflict handling — convergence is the
  framework's job behind `doc.applyRemote`.
- **P2 (mesh)** — main additionally joins a [truffle](https://github.com/jamesyong-42/truffle)
  mesh (Tailscale tsnet embedded in-process): app instances on other machines discover each other by
  appId on your tailnet and become room members — durable loro sync + bootstrap snapshots over raw
  QUIC streams (each snapshot on its own stream, so a 1-2MB join never head-of-line-blocks live
  increments), presence over UDP datagrams (latest-lossy, ≤ ~1,200B, oversize falls back reliable).
  No server anywhere, and no Tailscale install needed: the app itself is the tailnet node.

## Run

```bash
pnpm install               # repo root
pnpm example:canvas        # terminal 1 — the UI dev server (vite, :5173)
pnpm example:desktop       # terminal 2 — the Electron shell
```

**Cmd/Ctrl+N** opens a second window — a second collaborator in the room, converging over IPC with
zero network. `CANVAS_URL` overrides the dev-server origin; `STRATA_ROOM` overrides the room name
(default `demo`).

### Across machines (the mesh)

Put a Tailscale auth key in `examples/canvas-desktop/.env` (gitignored):

```
TS_AUTHKEY=tskey-auth-…    # Reusable + Ephemeral, e.g. tagged tag:strata-collab
```

Then `pnpm example:desktop` on each machine (each needs its own dev server, or set `CANVAS_URL`).
Instances register as ephemeral tailnet nodes (`truffle-strata-collab-…`), find each other by appId,
and link up — the same room converges across machines with zero server. Without an auth key the
first run opens a browser to authenticate the node interactively; without any tailnet the app just
runs local-only.

A joining instance holds its first window until the mesh link is up (or an 8s grace) — a window that
hellos before the link would seed its own divergent genesis and quarantine on contact (the
split-seed race). On any link up/down the windows' lifecycle bounces (close → open(reconnect)) and
the standard re-bootstrap repairs whatever the link outage dropped — truffle raw streams have no
replay, so re-bootstrap IS the recovery path.

Dev knobs: `STRATA_STATE_DIR` (tsnet state; set distinct dirs to run several instances on ONE
machine — each is its own tailnet node), `STRATA_DEVICE_NAME`, `STRATA_WINDOWS`, `STRATA_SCRIPT`.

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
