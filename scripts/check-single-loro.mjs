/**
 * Fail if any two workspace members would LOAD DIFFERENT COPIES of loro-crdt.
 *
 * loro-crdt is wasm with instance-identity checks: a LoroDoc built by one copy and handed to code
 * resolving another dies with `expected instance of LoroDoc`. That is a nasty failure to meet cold —
 * it surfaces far from its cause, as a pile of unrelated-looking end-to-end failures, and BOTH
 * `pnpm run ci` and `pnpm test:stress` stay fully green while it happens (nothing there hands a doc
 * across a package seam). It has cost two separate misdiagnoses in this repo.
 *
 * `pnpm.overrides` ("loro-crdt": "$loro-crdt") should make this structurally impossible by pinning
 * every member and transitive dependant to the root's version. This is the assertion that the
 * override is doing its job — cheap insurance turning a re-diagnosis into one error line.
 *
 * It resolves the package from each member the way NODE will at runtime and compares real paths.
 * Do NOT instead count `node_modules/.pnpm/loro-crdt@*` directories: that store retains orphaned
 * versions from earlier installs, so it reports duplicates that nothing links (the first cut of this
 * script did exactly that and cried wolf on a clean tree).
 */
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace member dirs, read from pnpm-workspace.yaml's literal `- "path"` entries, plus the root. */
function members() {
  const out = [ROOT];
  let yaml;
  try {
    yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return out;
  }
  for (const line of yaml.split("\n")) {
    const m = /^\s*-\s*["']?([^"'#\s]+)["']?\s*$/.exec(line);
    if (m && !m[1].includes("*")) out.push(join(ROOT, m[1]));
  }
  return out;
}

const byPath = new Map(); // realpath -> { version, members[] }
for (const dir of members()) {
  let resolved;
  try {
    // Resolve exactly as Node would for code living in that member.
    resolved = realpathSync(createRequire(join(dir, "package.json")).resolve("loro-crdt/package.json"));
  } catch {
    continue; // this member does not depend on loro-crdt — nothing to check
  }
  let entry = byPath.get(resolved);
  if (entry === undefined) {
    const version = JSON.parse(readFileSync(resolved, "utf8")).version;
    byPath.set(resolved, (entry = { version, members: [] }));
  }
  entry.members.push(dir === ROOT ? "." : dir.slice(ROOT.length + 1));
}

if (byPath.size > 1) {
  process.stderr.write(`\n✗ ${byPath.size} distinct loro-crdt copies are resolvable:\n`);
  for (const [path, { version, members: ms }] of byPath) {
    process.stderr.write(`    ${version}  ← ${ms.join(", ")}\n      ${path}\n`);
  }
  process.stderr.write(
    "\n  loro-crdt is wasm with instance-identity checks — a LoroDoc from one copy fails\n" +
      "  `expected instance of LoroDoc` in the other. Bump it with `pnpm update -r loro-crdt`\n" +
      "  (which moves every workspace member together), never `pnpm add -w` alone.\n",
  );
  process.exit(1);
}

const only = [...byPath.values()][0];
process.stdout.write(
  only === undefined
    ? "check-single-loro: ok (no member resolves loro-crdt)\n"
    : `check-single-loro: ok — one copy, ${only.version} (${only.members.join(", ")})\n`,
);
