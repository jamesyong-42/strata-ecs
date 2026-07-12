/**
 * Consumer smoke — validates the PACKAGED ARTIFACT, not the repository sources.
 *
 * `pnpm run ci` proves the sources; this proves what `npm install @vibecook/strata-ecs`
 * actually delivers: the exports map resolves, every dist file the map names exists, core
 * works WITHOUT the optional peers (react, loro-crdt), the peer-gated subpaths fail with a
 * CLEAR module-not-found when their peer is absent and work once it is installed, and a
 * Vite production build of a consumer app succeeds and produces a runnable bundle.
 *
 * Run locally:  pnpm build && pnpm smoke:consumer
 * CI:           the `consumer` matrix job (ubuntu/windows/macos) runs this on every push.
 *
 * Consumer deps (react, loro-crdt, vite) install at `latest` DELIBERATELY — this job is
 * the early-warning line for ecosystem drift; the pinned repo lockfile remains the primary
 * merge gate. Everything here is plain cross-platform Node: no bash, no cwd games beyond
 * child processes, temp dirs under os.tmpdir().
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let step = 0;
function log(msg) {
  step += 1;
  console.log(`\n[consumer-smoke ${step}] ${msg}`);
}

/** Run a command in `cwd`, inheriting output. Throws (fails the smoke) on non-zero exit. */
function run(cmd, cwd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

/** Run a command in `cwd`, capturing stdout. */
function runCapture(cmd, cwd) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();
}

function fail(msg) {
  console.error(`\nconsumer-smoke FAIL: ${msg}`);
  process.exit(1);
}

// --- 1. The exports map must not name files the tarball won't contain -----------------------
// Walk package.json `exports` and require every referenced path to exist on disk. This is the
// "bundle dependency verification" line: a build-layout change that orphans a map entry fails
// here, before any consumer sees ERR_MODULE_NOT_FOUND.
log("verify every exports-map target exists in dist/");
if (!existsSync(join(ROOT, "dist"))) {
  fail("dist/ missing — run `pnpm build` first (CI builds before invoking this script).");
}
const mapTargets = [];
(function collect(node) {
  if (typeof node === "string") {
    if (node.startsWith("./dist/")) mapTargets.push(node);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collect(v);
  }
})(PKG.exports);
for (const rel of mapTargets) {
  if (!existsSync(join(ROOT, rel))) fail(`exports map names ${rel}, which does not exist`);
}
console.log(`  ok — ${mapTargets.length} exports-map targets present`);

// --- 2. Pack the tarball and install it into a fresh consumer project -----------------------
log("npm pack");
const packDir = mkdtempSync(join(tmpdir(), "strata-pack-"));
const packOut = runCapture(`npm pack --pack-destination "${packDir}"`, ROOT).trim();
const tarball = join(packDir, packOut.split(/\r?\n/).pop());
if (!existsSync(tarball)) fail(`npm pack reported ${tarball}, which does not exist`);

log("fresh consumer project (no optional peers)");
const consumer = mkdtempSync(join(tmpdir(), "strata-consumer-"));
console.log(`  consumer dir: ${consumer}`);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ name: "strata-consumer-smoke", private: true, type: "module" }, null, 2),
);
// Both peers are peerDependenciesMeta.optional, so npm must NOT auto-install them — phase A
// below only means something if node_modules genuinely lacks react and loro-crdt.
run(`npm install "${tarball}" --no-audit --no-fund --loglevel=error`, consumer);
for (const peer of ["react", "loro-crdt"]) {
  if (existsSync(join(consumer, "node_modules", peer))) {
    fail(`optional peer "${peer}" was auto-installed — phase A would be meaningless`);
  }
}

// --- 3. Phase A: core + ephemeral + tools work with ZERO optional peers ---------------------
log("phase A — core functional smoke, no optional peers installed");
writeFileSync(
  join(consumer, "a-core.mjs"),
  `import {
  createWorld, defineComponent, defineTag, defineQuery, defineSystem, defineTickSystem, phase,
} from "@vibecook/strata-ecs";
import { attachObserver } from "@vibecook/strata-ecs/tools";

// Subpaths that need no peer must import and expose their surface in plain Node. That is the
// core entry and /tools; /durable and /ephemeral are the Loro collab layers (loro-crdt peer),
// /react needs react — those are pinned in a-peer-absence.mjs / phase B.
if (typeof attachObserver !== "function") throw new Error("attachObserver is not a function");

// Functional core: tick system runs once per dispatch, ctx.query sums across archetypes,
// and a tag-anchored system with zero matches never runs (the 0.5.0 batch invariant).
const Pos = defineComponent("Pos", { x: "f32" });
const Aux = defineComponent("Aux", { n: "u32" });
const Anchor = defineTag("Anchor");
const world = createWorld();
world.spawn({ components: [[Pos, { x: 3 }]] });
world.spawn({ components: [[Pos, { x: 4 }], [Aux, { n: 0 }]] });

let tickRuns = 0, sum = 0, anchorRuns = 0;
const q = defineQuery([Pos]);
const camera = defineTickSystem((ctx) => {
  tickRuns++;
  ctx.query(q).each((b) => { const x = b.col(Pos).x; for (const r of b) sum += x[r]; });
});
const anchored = defineSystem(defineQuery([Anchor]), () => anchorRuns++);
world.tick([phase("p", [camera, anchored])]);
world.tick([phase("p", [camera, anchored])]);

if (tickRuns !== 2 || sum !== 14 || anchorRuns !== 0) {
  throw new Error(\`functional smoke: tickRuns=\${tickRuns} (want 2) sum=\${sum} (want 14) anchorRuns=\${anchorRuns} (want 0)\`);
}
console.log("phase A ok — tickRuns=2 sum=14 anchorRuns=0");
`,
);
run("node a-core.mjs", consumer);

log("phase A — peer-gated subpaths fail CLEARLY when the peer is absent");
writeFileSync(
  join(consumer, "a-peer-absence.mjs"),
  `// The peer-gated subpaths require their optional peer: /durable and /ephemeral are the Loro
// collab layers, /react is the react binding. Without the peer, the failure mode a consumer
// sees must be node's module-not-found NAMING THE PEER — not a cryptic downstream crash.
for (const [subpath, peer] of [["durable", "loro-crdt"], ["ephemeral", "loro-crdt"], ["react", "react"]]) {
  let failed = false;
  try {
    await import("@vibecook/strata-ecs/" + subpath);
  } catch (err) {
    failed = true;
    const msg = String(err && err.message);
    if (err.code !== "ERR_MODULE_NOT_FOUND" || !msg.includes(peer)) {
      throw new Error("importing /" + subpath + " without " + peer + " should be ERR_MODULE_NOT_FOUND naming it, got: " + msg);
    }
  }
  if (!failed) throw new Error("importing /" + subpath + " without " + peer + " unexpectedly succeeded");
}
console.log("phase A ok — /durable, /ephemeral, /react fail with a clear module-not-found for their peer");
`,
);
run("node a-peer-absence.mjs", consumer);

// --- 4. Phase B: install the optional peers, durable + react subpaths work ------------------
log("phase B — install optional peers (latest), durable + react subpaths");
run("npm install react@latest loro-crdt@latest --no-audit --no-fund --loglevel=error", consumer);
writeFileSync(
  join(consumer, "b-durable.mjs"),
  `import { LoroDoc } from "loro-crdt";
import { createWorld, defineComponent } from "@vibecook/strata-ecs";
import { attachDurable, createDurableStore } from "@vibecook/strata-ecs/durable";

// Packaging scope: the loro-crdt wasm peer loads in plain Node and the attach lifecycle
// round-trips. Projection depth is the repo test suite's job, not the consumer smoke's.
const Pos = defineComponent("Pos", { x: "f32" });
const world = createWorld();
const store = createDurableStore(new LoroDoc());
const att = attachDurable(world, store);
world.spawn({ components: [[Pos, { x: 1 }]] });
att.detach();

// /ephemeral resolves and exposes its surface once loro-crdt is present.
const eph = await import("@vibecook/strata-ecs/ephemeral");
for (const name of ["createEphemeralStore", "attachEphemeral"]) {
  if (typeof eph[name] !== "function") throw new Error("/ephemeral export " + name + " is not a function");
}
console.log("phase B ok — durable attach/spawn/detach round-trip; /ephemeral resolves");
`,
);
run("node b-durable.mjs", consumer);
writeFileSync(
  join(consumer, "b-react.mjs"),
  `import { useComponent, useResource } from "@vibecook/strata-ecs/react";
if (typeof useComponent !== "function" || typeof useResource !== "function") {
  throw new Error("react binding exports are not functions");
}
console.log("phase B ok — react binding imports with react installed");
`,
);
run("node b-react.mjs", consumer);

// --- 5. Phase C: a Vite production build of a consumer app ----------------------------------
log("phase C — Vite production build (self-checking bundle)");
run("npm install -D vite@latest --no-audit --no-fund --loglevel=error", consumer);
// Same functional smoke, but as a BUILT artifact: vite lib-mode bundles the package (nothing
// external), so the output is a self-contained ESM file node can execute. The entry throws on
// any wrong result, and prints a marker the parent asserts — an over-aggressive tree-shake
// that empties the bundle cannot pass silently.
writeFileSync(
  join(consumer, "c-entry.js"),
  readFileSync(join(consumer, "a-core.mjs"), "utf8").replace(
    'console.log("phase A ok',
    'console.log("CONSUMER_BUNDLE_OK', // the marker phase C greps for
  ),
);
writeFileSync(
  join(consumer, "vite.config.js"),
  `import { defineConfig } from "vite";
export default defineConfig({
  logLevel: "warn",
  build: { lib: { entry: "c-entry.js", formats: ["es"], fileName: () => "bundle.js" } },
});
`,
);
run("npx vite build", consumer);
const bundlePath = join(consumer, "dist", "bundle.js");
if (!existsSync(bundlePath)) fail("vite build produced no dist/bundle.js");
const bundleOut = runCapture("node dist/bundle.js", consumer);
if (!bundleOut.includes("CONSUMER_BUNDLE_OK")) {
  fail(`built bundle ran but did not print its marker; stdout was:\n${bundleOut}`);
}
console.log("  ok — production bundle builds and executes correctly");

// --- done ------------------------------------------------------------------------------------
log("PASS — packaged artifact verified");
for (const dir of [packDir, consumer]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup (Windows can hold file locks briefly); temp dirs are disposable.
  }
}
