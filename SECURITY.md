# Security policy

## Supported versions

strata-ecs is pre-1.0. Only the **latest published version** receives fixes; there are no
maintenance branches. Pin a version and read the [CHANGELOG](CHANGELOG.md) before upgrading —
minor versions may carry breaking API changes.

## Reporting a vulnerability

Please report privately via
[GitHub's private vulnerability reporting](https://github.com/jamesyong-42/strata-ecs/security/advisories/new)
rather than opening a public issue.

Include what you were running (version, which subpath, which peer versions), what you observed,
and a reproduction if you have one. This is a small project maintained by one person — expect a
first response in days, not hours.

## What is in scope

The library's trust boundary is **bytes from other peers**. `applyRemote`, the ephemeral store's
inbound path, and snapshot import all consume data an attacker may control, and they are written
to a documented discipline: a hostile or malformed payload must be *soft-rejected* — never
mis-bound to the wrong entity, never able to throw out of `world.sync()`, never able to corrupt
converged state. Concretely, in scope:

- A crafted document or update that **corrupts or mis-binds state** — cells landing on the wrong
  entity, reserved names being spoofed, relation-edge keys colliding.
- A crafted payload that **escapes the quarantine contract** — throwing where the API promises a
  soft reject, or poisoning a store so later honest updates fail.
- A crafted payload causing **unbounded memory or CPU growth** disproportionate to its size.
- Anything that lets document bytes **execute code** or escape the adapter seam.

Reports that come with a failing test against the conformance or fuzz suites are especially
welcome — that is how this layer is specified.

## What is out of scope

- **The examples.** `examples/collab-server`, `examples/headless-host`, `examples/canvas-editor`
  and `examples/canvas-desktop` are demonstrations, not products. The relays have no
  authentication, no authorization, no rate limiting, and the WebSocket relay has no TLS; this is
  stated in their READMEs. "The demo relay lets anyone join any room" is a documented property,
  not a vulnerability. Do not deploy them.
- **Transport security.** The library moves opaque bytes and never opens a socket. Authenticating
  peers, encrypting the wire, and authorizing room access are the embedding application's job.
- **Denial of service by an authorized peer.** Any peer permitted to write the document can write
  a very large one. Bounding that is the application's policy decision.
- **Vulnerabilities in `loro-crdt`.** Report those to
  [loro-dev/loro](https://github.com/loro-dev/loro). If a loro issue is reachable *through* an API
  we expose in a way its own docs would not predict, that seam is ours — please tell us too.
