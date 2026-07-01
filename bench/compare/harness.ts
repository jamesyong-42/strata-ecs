/**
 * Per-library benchmark harness. Run as its OWN process (one library per `node` invocation) so
 * megamorphic inline-cache contamination and koota's global `Number.prototype` patch never bleed
 * across libraries. Usage:
 *
 *   node --expose-gc --allow-natives-syntax harness.ts ./scenarios/<lib>.ts
 *
 * Emits one machine-readable line to stdout: `BENCH_JSON:{...}` with per-scenario avg/p75/p99 (ns)
 * and the parity checksum. mitata runs in quiet mode; the runner (run.mjs) aggregates the JSON.
 */

import { bench, do_not_optimize, run } from "mitata";
import type { LibraryBench } from "./contract.ts";

const modPath = process.argv[2];
if (!modPath) {
  console.error("usage: node harness.ts ./scenarios/<lib>.ts");
  process.exit(2);
}

const mod = (await import(modPath)) as { default: LibraryBench };
const lib = mod.default;

const checksums: Record<string, number> = {};
for (const sc of lib.scenarios) {
  const state = sc.setup();
  checksums[sc.id] = sc.run(state); // one run from fresh setup → the parity checksum
  bench(sc.id, () => {
    do_not_optimize(sc.run(state));
  });
}

const res = await run({ format: "quiet" });

const out = {
  lib: lib.name,
  version: lib.version,
  context: {
    cpu: res.context?.cpu?.name ?? "unknown",
    arch: res.context?.arch ?? "unknown",
    node: res.context?.version ?? process.version,
  },
  results: res.benchmarks.map((b) => {
    const stats = b.runs[0]?.stats;
    return {
      id: b.alias,
      avg_ns: stats?.avg ?? null,
      p75_ns: stats?.p75 ?? null,
      p99_ns: stats?.p99 ?? null,
      checksum: checksums[b.alias as string] ?? null,
    };
  }),
};

process.stdout.write(`BENCH_JSON:${JSON.stringify(out)}\n`);
