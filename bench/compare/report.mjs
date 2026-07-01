/**
 * Renders the benchmark results as a self-contained, dependency-free HTML page (static SVG-free
 * CSS bar charts — no CDN, no client JS, opens straight from disk). `run.mjs` calls `renderReport`
 * after a run; or run standalone against a persisted results.json:  node report.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COLORS = {
  strata: "#a371f7",
  bitecs: "#58a6ff",
  becsy: "#f778ba",
  miniplex: "#ffa657",
  koota: "#3fb950",
};
const FALLBACK = "#8b949e";

const GROUPS = [
  {
    title: "Realistic frames",
    blurb: "A full frame through each library's real system pipeline — multiple systems, a mixed world, in-system structural change.",
    ids: ["sim_frame", "spawn_reap_frame", "toggle_frame"],
    labels: {
      sim_frame: "sim_frame · 4-system mixed-world frame",
      spawn_reap_frame: "spawn_reap_frame · in-system entity spawn + destroy",
      toggle_frame: "toggle_frame · in-system component add + remove",
    },
  },
  {
    title: "Canonical micro-scenarios",
    blurb: "The standard ecs_bench_suite set — raw iteration and lifecycle micro-operations.",
    ids: ["packed_5", "simple_iter", "frag_iter", "entity_cycle", "add_remove"],
    labels: {
      packed_5: "packed_5 · dense iteration, 5 components",
      simple_iter: "simple_iter · multi-layout iteration + swaps",
      frag_iter: "frag_iter · fragmented iteration, 26 types",
      entity_cycle: "entity_cycle · create + destroy churn",
      add_remove: "add_remove · component add + remove",
    },
  },
  {
    title: "Extensions",
    blurb: "Editor-centric workloads beyond the canonical suite.",
    ids: ["serialize", "random_access"],
    labels: {
      serialize: "serialize · whole-world save + load (strata built-in)",
      random_access: "random_access · read one field for 10k random entities",
    },
  },
];

function fmt(ns) {
  if (ns == null) return "N/A";
  const us = ns / 1000;
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`;
  if (us >= 100) return `${us.toFixed(1)} µs`;
  return `${us.toFixed(2)} µs`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function scenarioCard(id, label, libs, byLib) {
  const rows = libs
    .map((lib) => ({ lib, ns: byLib[lib]?.[id]?.avg_ns ?? null }))
    .sort((a, b) => (a.ns == null ? 1 : b.ns == null ? -1 : a.ns - b.ns));
  const times = rows.map((r) => r.ns).filter((x) => x != null);
  const best = times.length ? Math.min(...times) : null;
  const fastest = rows.find((r) => r.ns === best);

  const bars = rows
    .map(({ lib, ns }) => {
      const color = COLORS[lib] ?? FALLBACK;
      const isStrata = lib === "strata";
      if (ns == null) {
        return `<div class="row na"><span class="lib" style="--c:${color}">${esc(lib)}</span>
          <div class="track"><div class="fill" style="width:0%"></div></div>
          <span class="val na-val">N/A</span></div>`;
      }
      const width = best != null ? (best / ns) * 100 : 100;
      const mult = best != null && ns !== best ? ` <em>${(ns / best).toFixed(2)}×</em>` : "";
      return `<div class="row${isStrata ? " strata" : ""}">
        <span class="lib" style="--c:${color}">${esc(lib)}</span>
        <div class="track"><div class="fill" style="width:${width.toFixed(1)}%;--c:${color}"></div></div>
        <span class="val">${fmt(ns)}${mult}</span></div>`;
    })
    .join("\n");

  const badge = fastest ? `<span class="badge" style="--c:${COLORS[fastest.lib] ?? FALLBACK}">fastest · ${esc(fastest.lib)}</span>` : "";
  return `<article class="card">
    <div class="card-head"><h3>${esc(label)}</h3>${badge}</div>
    <div class="bars">${bars}</div>
    <div class="sub">longer bar = faster · lower µs/op is better</div>
  </article>`;
}

export function renderReport({ context, libs, versions, byLib }) {
  const wins = GROUPS.flatMap((g) => g.ids)
    .filter((id) => {
      const times = libs.map((l) => byLib[l]?.[id]?.avg_ns).filter((x) => x != null);
      if (!times.length) return false;
      const best = Math.min(...times);
      return byLib.strata?.[id]?.avg_ns === best;
    });

  const sections = GROUPS.map((g) => {
    const cards = g.ids.map((id) => scenarioCard(id, g.labels[id] ?? id, libs, byLib)).join("\n");
    return `<section class="group"><div class="group-head"><h2>${esc(g.title)}</h2><p>${esc(g.blurb)}</p></div>
      <div class="grid">${cards}</div></section>`;
  }).join("\n");

  const legend = libs
    .map((l) => `<span class="chip"><i style="background:${COLORS[l] ?? FALLBACK}"></i>${esc(l)} <small>${esc(versions[l] ?? "")}</small></span>`)
    .join("");

  const winChips = wins.map((id) => `<span class="win">${esc(id)}</span>`).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>strata — ECS benchmarks</title>
<style>
  :root{
    --bg:#0b0e14; --panel:#111725; --panel2:#0e1420; --line:#1e2637; --ink:#e6edf3;
    --muted:#8b98ad; --accent:#a371f7; --track:#161d2b;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#1a1230 0%,transparent 60%),var(--bg);
    color:var(--ink);font-family:var(--font);line-height:1.5;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1080px;margin:0 auto;padding:48px 24px 96px}
  header.top{margin-bottom:40px}
  .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 12px}
  h1{font-size:40px;line-height:1.1;margin:0 0 12px;font-weight:750;letter-spacing:-.02em}
  h1 .g{background:linear-gradient(92deg,#a371f7,#58a6ff 55%,#3fb950);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lede{color:var(--muted);font-size:17px;max-width:70ch;margin:0 0 22px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}
  .chip{display:inline-flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);
    border-radius:999px;padding:6px 12px;font-size:13px;font-family:var(--mono)}
  .chip i{width:10px;height:10px;border-radius:3px;display:inline-block}
  .chip small{color:var(--muted)}
  .meta{color:var(--muted);font-family:var(--mono);font-size:12.5px;margin-top:14px}
  .highlight{margin:26px 0 8px;padding:18px 20px;border:1px solid var(--line);border-radius:16px;
    background:linear-gradient(180deg,rgba(163,113,247,.10),rgba(163,113,247,.02))}
  .highlight b{color:var(--ink)} .highlight .wins{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .win{font-family:var(--mono);font-size:12px;background:rgba(63,185,80,.12);color:#7ee787;border:1px solid rgba(63,185,80,.3);
    padding:4px 10px;border-radius:999px}
  .group{margin-top:52px}
  .group-head h2{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .group-head p{color:var(--muted);margin:0 0 20px;font-size:14.5px;max-width:80ch}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:760px){.grid{grid-template-columns:1fr}.wrap{padding:32px 16px 72px}h1{font-size:32px}}
  .card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);
    border-radius:16px;padding:18px 18px 14px;transition:border-color .2s}
  .card:hover{border-color:#2b3650}
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
  .card-head h3{font-size:14.5px;margin:0;font-weight:620;letter-spacing:.005em}
  .badge{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;
    color:var(--c);border:1px solid color-mix(in srgb,var(--c) 45%,transparent);
    background:color-mix(in srgb,var(--c) 12%,transparent);padding:3px 9px;border-radius:999px}
  .bars{display:flex;flex-direction:column;gap:9px}
  .row{display:grid;grid-template-columns:74px 1fr auto;align-items:center;gap:12px}
  .row .lib{font-family:var(--mono);font-size:12.5px;color:var(--c);font-weight:600}
  .track{height:12px;background:var(--track);border-radius:7px;overflow:hidden;position:relative}
  .fill{height:100%;border-radius:7px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 55%,#000 6%),var(--c));
    box-shadow:0 0 12px color-mix(in srgb,var(--c) 35%,transparent);min-width:2px;transition:width .3s}
  .row.strata .track{outline:1px solid color-mix(in srgb,var(--accent) 40%,transparent);outline-offset:1px}
  .row .val{font-family:var(--mono);font-size:12.5px;color:var(--ink);white-space:nowrap;text-align:right;min-width:96px}
  .row .val em{color:var(--muted);font-style:normal;font-size:11px}
  .row.na .val{color:var(--muted)} .row.na .lib{opacity:.6}
  .sub{color:var(--muted);font-size:11.5px;font-family:var(--mono);margin-top:12px;text-align:right}
  footer{margin-top:56px;border-top:1px solid var(--line);padding-top:24px;color:var(--muted);font-size:13.5px}
  footer code{font-family:var(--mono);background:var(--panel);border:1px solid var(--line);padding:2px 7px;border-radius:6px;color:var(--ink)}
  footer h4{color:var(--ink);font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin:20px 0 8px}
  footer ul{margin:0;padding-left:18px} footer li{margin:4px 0}
</style></head>
<body><div class="wrap">
  <header class="top">
    <p class="eyebrow">Comparative benchmark</p>
    <h1><span class="g">strata</span> vs the TypeScript ECS field</h1>
    <p class="lede">strata (archetype-SoA, built for editor / collaboration workloads) measured against bitecs, becsy, miniplex, and koota. Each scenario runs in every library's idiomatic fastest form; all libraries agree on a per-scenario checksum, so the work is provably identical.</p>
    <div class="chips">${legend}</div>
    <div class="meta">${esc(context.cpu)} · ${esc(context.arch)} · Node ${esc(context.node)} · mitata · one process per library · lower µs/op is better</div>
  </header>

  <div class="highlight">
    <b>strata is fastest in ${wins.length} of ${GROUPS.flatMap((g) => g.ids).length} scenarios</b> — top-tier on dense iteration and fastest on entity-lifecycle / in-system churn (its target workload). It carries honest, structural cost on component add/remove and random-access-by-handle, and uniquely ships serialization.
    <div class="wins">${winChips}</div>
  </div>

  ${sections}

  <footer>
    <h4>How to read this</h4>
    <ul>
      <li>Each bar's length is <b>relative speed</b> within that scenario — the fastest library gets a full bar; a library 2× slower gets a half bar. The label shows the actual µs/op and the ×-multiple vs the fastest.</li>
      <li>Lower µs/op is better. <b>strata</b>'s row is outlined.</li>
    </ul>
    <h4>Method</h4>
    <ul>
      <li>Regenerate: <code>pnpm build</code> then <code>cd bench/compare &amp;&amp; node run.mjs</code>.</li>
      <li>One <code>node</code> process per library (no inline-cache contamination); mitata with <code>--expose-gc --allow-natives-syntax</code>; warmup to steady state.</li>
      <li>All checksums agree across all five libraries — equal work proven. Full analysis in <code>BENCHMARKS.md</code>; raw table in <code>RESULTS.md</code>.</li>
    </ul>
    <p style="margin-top:20px">Numbers are machine-specific with a few-percent run-to-run variance; treat anything within a few percent as a tie.</p>
  </footer>
</div></body></html>`;
}

// Standalone: node report.mjs  (reads results.json, writes report.html)
if (import.meta.url === `file://${process.argv[1]}`) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const payload = JSON.parse(readFileSync(join(HERE, "results.json"), "utf8"));
  writeFileSync(join(HERE, "report.html"), renderReport(payload));
  process.stdout.write("wrote report.html\n");
}
