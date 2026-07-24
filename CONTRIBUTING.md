# Contributing

Thanks for looking. This is a small, opinionated library maintained by one person — the fastest
way to get a change landed is to make it easy to verify.

## Setup

Node comes from `.nvmrc` (24) and pnpm from `packageManager` in `package.json`. Both matter:
a different Node breaks some DOM-dependent tests locally, and a different pnpm resolves the
workspace differently.

```sh
nvm use          # or otherwise match .nvmrc
pnpm install
pnpm run ci      # the gate — see below
```

## The gate

`pnpm run ci` is the merge gate and runs `check:deps` → typecheck → lint → tests → stress smoke.
Keep it green at every commit.

If you touch the **durable or ephemeral layers**, `ci` alone is not sufficient. Also run:

```sh
pnpm test:stress                                   # heavy fuzz + CRDT reconcile conformance
pnpm build && pnpm smoke:headless                  # end-to-end sync over real sockets
node scripts/consumer-smoke.mjs                    # the packaged artifact, if packaging changed
```

The headless smoke matters more than its size suggests: it is the only test that hands a document
across a package seam, so it catches a whole class of failure the unit suites are blind to. Two
separate misdiagnoses in this repo's history trace to skipping it.

## Things that will bite you

- **One loro copy, always.** `loro-crdt` is wasm with instance-identity checks — two copies in the
  tree make a `LoroDoc` from one fail `expected instance of LoroDoc` in the other, invisibly to
  `ci` and `test:stress`. The root's `pnpm.overrides` prevents this and `pnpm check:deps` asserts
  it. Bump loro with `pnpm update -r loro-crdt`, never `pnpm add -w` alone.
- **Never run Prettier over `docs/*.html`.** Those pages are hand-formatted; they are in
  `.prettierignore` for that reason. A blanket `prettier --write` once reflowed a doc page from
  1,886 to 3,594 lines.
- **`pnpm run ci`, not `pnpm ci`.** The latter is a different (npm) command.
- **DEV diagnostics must be dead in production builds.** Put `if (!DEV) return` as the *first* line
  of a diagnostic helper, and gate the call site with `if (DEV)` whenever the call site builds the
  message. A helper-internal gate cannot remove a string the caller already concatenated.

## Performance changes

Anything touching the hot path (iteration, spawn, archetype migration) or the sync path needs a
measurement, not an argument:

```sh
pnpm bench          # the library's own micro-benchmarks
pnpm bench:sync     # the sync-path growth law — see bench/sync/README.md
```

Two rules learned the hard way, both enforced by the harnesses:

- **Check the machine first.** `ps aux` and the load average. Published numbers here have twice
  turned out to be artifacts — once a stray busy loop inflating every library 3–6x, once wasm-heap
  warming making a measurement look 30x faster than it was.
- **Measure the shape, not just the number.** A growth law (does cost track input size or document
  size?) survives a noisy machine; absolute milliseconds do not.

Published benchmark docs show **only current valid results** — no change history, no
old-versus-new framing.

## Pull requests

- Keep the gate green, and say which suites you ran.
- Explain *why* in the commit message. This codebase's comments and commits carry the reasoning
  behind non-obvious decisions — especially where a CRDT or wasm behaviour forced our hand — and
  that is deliberate. If you found a surprising fact, write it down where the next person will hit it.
- If a change alters observable behaviour, pin it with a test rather than describing it. If it
  loosens an existing pin, say so explicitly and explain why the weaker property is the honest one.
- Draft PRs welcome for direction checks before you invest in a full implementation.

## Reporting bugs

Include the version, which subpath (`/durable`, `/ephemeral`, `/react`, `/tools`), your
`loro-crdt` version if a collaboration layer is involved, and ideally a failing test. For security
issues see [SECURITY.md](SECURITY.md) — please do not open a public issue for those.
