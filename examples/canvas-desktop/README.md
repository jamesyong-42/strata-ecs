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

## Packaging (a distributable .app)

Everything above runs against the vite dev server. To build a **standalone macOS app** that ships the
built UI and the truffle sidecar and launches with no server:

```bash
pnpm --filter @strata-ecs/example-canvas-desktop package
# → examples/canvas-desktop/dist/canvas-desktop-darwin-arm64/canvas-desktop.app  (~306 MB)
```

Target is **darwin-arm64** (the only verified platform). The app is unsigned — first launch needs a
Gatekeeper right-click → Open, or `xattr -dr com.apple.quarantine <app>`.

**How it's built** (`scripts/package.mjs`): the renderer is `vite build`'d, then a *flat, symlink-free*
`node_modules` holding exactly the runtime closure — `@vibecook/truffle`, its `truffle-native` (the
`.node`), the `truffle-sidecar-darwin-arm64` binary, and `ws` — is staged beside `src/` and the built
renderer, and [`@electron/packager`](https://github.com/electron/packager) wraps it into a `.app`.
Materializing those four packages as real directories sidesteps pnpm's symlinked `.pnpm` store, which
is the classic packager pain (and `pnpm deploy` keeps that store *and* ships every platform's `.node`
plus the gitignored `.env`). Only `darwin-arm64` binaries are kept; the rest are pruned.

**`asarUnpack` — the two native bits that can't live in the asar** (`asar: { unpack, unpackDir }`):

- `**/*.node` — `truffle-native`'s addon. `process.dlopen` needs a real file path; it can't load from
  inside an asar archive.
- `**/truffle-sidecar-darwin-arm64` — the Go sidecar binary. It's **spawned as a subprocess**, so it
  must be an executable file on disk. `main.mjs` points truffle's `sidecarPath` explicitly at
  `Resources/app.asar.unpacked/…/bin/sidecar-slim` (truffle's own auto-resolution would hand back an
  in-asar path that can't be spawned).

**The renderer is served over http, not `file://`.** Packaged, `main.mjs` starts a tiny loopback
static server (`src/static-server.mjs`) over the built dist and points `CANVAS_URL` at it — every
other line of the window code stays identical to the dev path. http (not `file://`) is required because
the renderer `fetch()`es loro's wasm, and browsers refuse `fetch` of `file://` URLs. The server
replicates vite's `Cross-Origin-Opener-Policy`/`Embedder-Policy` headers so the page stays
cross-origin-isolated (the HUD's `performance.now()` precision). `base` stays `/` (absolute
`/assets/…` served from the origin root) — **no change to `vite.config.ts`**, so the dev and Pages
builds are untouched.

**Config, packaged** — `TS_AUTHKEY` (and the other `STRATA_*` knobs) are read with this precedence,
lowest to highest:

1. `.env` beside `src/` — the dev location; inside the asar when packaged, so nothing is read there
   (the secret is deliberately **not** bundled).
2. **`~/Library/Application Support/canvas-desktop/.env`** — the packaged user's config file.
3. real environment variables — override everything (how the smoke injects the key).

So a distributed app reads its auth key from `~/Library/Application Support/canvas-desktop/.env`; tsnet
state lives in that same userData dir (`tsnet/`).

**Later, for Windows/Linux** (not built here): swap the sidecar package + `.node` for the target
triple (`truffle-sidecar-${platform}-${arch}`, `sidecar-slim.exe` on Windows — `packagedSidecarPath()`
already computes this), package on/for that OS, and note that embedded tsnet **won't start on Windows
alongside a host Tailscale service** (`syspolicy … Access is denied`, measured in the mesh section).

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

## Measured: what the tsnet mesh costs

P3 drove the real `mesh.mjs` link manager (truffle 0.5.1) over three lanes, all timed **round-trip on
one clock** (≥2 reps/cell, warmup discarded, every snapshot sha256-verified). The clean number is the
**tsnet tax on one physical path**: same-host loopback, raw QUIC/UDP vs plain `ws`, so the only
variable is the transport stack.

| lane (same-host loopback) | tsnet + raw QUIC/UDP | plain `ws` (TCP) |
|---|---|---|
| echo RTT p50 · p99 | **0.95 · 6.5 ms** | 0.15 · 0.36 ms |
| 1.84 MiB snapshot | ~40 MB/s peak (17 mean) | 151 MB/s |
| 30 Hz UDP echo p50 · loss | 1.4 ms · **0%** | — |

So the embedded tsnet + QUIC framing adds **~0.8 ms per round trip** and caps a bootstrap snapshot at
**~40 MB/s** (vs 151) on the identical loopback path — the price of "the app is the tailnet node, no
server, no host Tailscale install". Snapshots are bimodal: the first few back-to-back transfers hit
40–46 MB/s, then degrade toward ~6 MB/s (per-transfer QUIC-stream + copy + sha cost, not the
network) — a single join stays in the fast mode.

**Relay worst case** (forced via `TS_DEBUG_ALWAYS_USE_DERP=1`): RTT jumps to **~40 ms p50** (p99 143,
relay jitter), snapshot to **2.5 MB/s** — but UDP presence still delivered with **0% loss** over 3.5k
datagrams. **UDP ceiling**: 100% delivery through **10 kHz** (>150× the 30–60 Hz presence cadence),
collapsing past ~30 kHz. **Idle survival**: a relayed link held 12 min on only the 60 s heartbeats
still delivered both lanes — the heartbeat clears the sidecar's ~10-min reap.

Two honesty notes: (1) truffle's `connectionType` is an unreliable path label here — it reports the
home DERP region (`relay:sfo`) even when data flows direct over loopback, so paths above are asserted
by measured latency, not that field. (2) The cross-machine tsnet-QUIC *direct* number is unmeasured:
embedded tsnet won't start on Windows alongside the host Tailscale service (`syspolicy … Access is
denied`). Plain `ws` over the host tailnet between the same two machines (direct WireGuard, 6 ms ping)
ran **5.25 ms p50 RTT / 5.95 MB/s** as a networked reference.
