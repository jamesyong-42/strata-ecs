/**
 * Package canvas-desktop into a distributable macOS .app (darwin-arm64).
 *
 * Why a hand-staged flat node_modules instead of pointing a packager at the pnpm workspace: the
 * example's runtime closure is tiny and exact — @vibecook/truffle + its truffle-native (.node) +
 * the platform sidecar binary + ws. pnpm's symlinked `.pnpm` store (and `pnpm deploy`, which keeps
 * that store and ships every platform's .node plus the gitignored .env) is the classic packager
 * pain. Materializing those four packages as real, symlink-free, arm64-only directories removes the
 * fight entirely and gives precise control over what asar unpacks.
 *
 * Steps: build the renderer (vite) → stage src + built renderer + flat node_modules + a clean
 * manifest → @electron/packager with asar, unpacking the .node and the sidecar (neither can run from
 * inside asar). Output: examples/canvas-desktop/dist/canvas-desktop-darwin-arm64/canvas-desktop.app.
 *
 * Usage: `pnpm --filter @strata-ecs/example-canvas-desktop package` (add `--skip-build` to reuse an
 * existing renderer dist while iterating).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const rendererDist = path.join(repoRoot, "examples", "canvas-editor", "dist");
const stageDir = path.join(desktopDir, "build", "stage");
const outDir = path.join(desktopDir, "dist");
const APP_NAME = "canvas-desktop";
const skipBuild = process.argv.includes("--skip-build");

const log = (m) => console.log(`[package] ${m}`);

// 1. Build the renderer (default vite build: base "/" so absolute /assets URLs serve from the
//    loopback origin root — NOT the DEMO_BASE Pages build, which this must never touch).
if (!skipBuild) {
  log("building renderer (vite)…");
  execFileSync("pnpm", ["--filter", "@strata-ecs/example-canvas-editor", "build"], { cwd: repoRoot, stdio: "inherit" });
}
if (!existsSync(path.join(rendererDist, "index.html")))
  throw new Error(`renderer dist missing at ${rendererDist} — run without --skip-build`);

// 2. Clean stage.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 3. Main-process source + built renderer.
cpSync(path.join(desktopDir, "src"), path.join(stageDir, "src"), { recursive: true });
cpSync(rendererDist, path.join(stageDir, "renderer"), { recursive: true });

// 4. Flat, real, arm64-only node_modules for the exact runtime closure. Resolve each package's real
//    directory dynamically (follows pnpm's symlinks) so no `.pnpm` hash is hard-coded here.
const requireDesktop = createRequire(path.join(desktopDir, "package.json"));
/** Nearest package.json dir at or above `startDir`, resolved through symlinks (pnpm store → real). */
function pkgRootFromFile(startDir) {
  let dir = startDir;
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${startDir}`);
    dir = parent;
  }
  return realpathSync(dir);
}
/** A package's real root dir via a require anchored in the resolver. `${spec}/package.json` when the
 *  exports map allows it (the sidecar has no map); otherwise climb from the main entry. */
function realDir(req, spec) {
  try {
    return realpathSync(path.dirname(req.resolve(`${spec}/package.json`)));
  } catch (e) {
    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw e;
    return pkgRootFromFile(path.dirname(req.resolve(spec)));
  }
}
// truffle is ESM-only (its "." export has no CJS condition), so require.resolve can't reach it —
// resolve via import.meta (ESM) and climb. Its deps then resolve off a require anchored inside it,
// whose module lookup reaches pnpm's peer store beside truffle.
const truffleDir = pkgRootFromFile(path.dirname(fileURLToPath(import.meta.resolve("@vibecook/truffle"))));
const requireTruffle = createRequire(path.join(truffleDir, "package.json"));
const closure = {
  "@vibecook/truffle": truffleDir,
  "@vibecook/truffle-native": realDir(requireTruffle, "@vibecook/truffle-native"),
  "@vibecook/truffle-sidecar-darwin-arm64": realDir(requireTruffle, "@vibecook/truffle-sidecar-darwin-arm64"),
  ws: realDir(requireTruffle, "ws"),
};
for (const [spec, src] of Object.entries(closure)) {
  const dest = path.join(stageDir, "node_modules", ...spec.split("/"));
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
}

// Drop every platform's prebuilt .node except this one (napi loader only requires darwin-arm64;
// the other ~30MB of binaries would just bloat the bundle).
const nativeDir = path.join(stageDir, "node_modules", "@vibecook", "truffle-native");
for (const f of readdirSync(nativeDir))
  if (f.endsWith(".node") && f !== "truffle.darwin-arm64.node") unlinkSync(path.join(nativeDir, f));

// 5. A clean manifest: unscoped name (→ app.getName() = "canvas-desktop", so userData is
//    ~/Library/Application Support/canvas-desktop), no deps (node_modules is prebuilt), no scripts.
const realPkg = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
writeFileSync(
  path.join(stageDir, "package.json"),
  JSON.stringify(
    { name: APP_NAME, productName: APP_NAME, version: realPkg.version, private: true, type: "module", main: "src/main.mjs" },
    null,
    2,
  ),
);

// 6. Wrap with Electron. asar on; unpack the .node (dlopen needs a real file) and the sidecar
//    package dir (spawned as a subprocess — main.mjs points sidecarPath at app.asar.unpacked/…).
const electronVersion = requireDesktop("electron/package.json").version;
log(`packaging with electron ${electronVersion}…`);
rmSync(path.join(outDir, `${APP_NAME}-darwin-arm64`), { recursive: true, force: true });
const [appPath] = await packager({
  dir: stageDir,
  out: outDir,
  name: APP_NAME,
  platform: "darwin",
  arch: "arm64",
  electronVersion,
  asar: { unpack: "**/*.node", unpackDir: "**/truffle-sidecar-darwin-arm64" },
  prune: false, // the stage is already exactly the runtime closure — pruning would invoke a package manager
  overwrite: true,
  derefSymlinks: true,
});
log(`done → ${appPath}`);
