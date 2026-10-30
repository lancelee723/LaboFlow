#!/usr/bin/env node
/**
 * Fetch pinned bundled plugins listed in apps/desktop/plugins.bundle.json
 * into apps/desktop/resources/plugins/ before packaging (ADR 0041).
 * `source` is a local directory (this iteration) or an http(s) .zip URL.
 * Validates manifest id + version; refuses anything else.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repoRoot, "apps/desktop/plugins.bundle.json");
const pluginsDir = join(repoRoot, "apps/desktop/resources/plugins");
const integratedDir = join(repoRoot, "apps/desktop/resources/ppt-master");

// Repo-hygiene files at a plugin source root that must never ship in a bundle.
const NONSHIPPED_TOP_LEVEL_FILES = new Set(["AGENTS.md", "README.md", "PROVENANCE.md"]);

function makeCopyFilter(src) {
  return (p) => {
    if (p.includes("__pycache__")) return false;
    const rel = relative(src, p);
    if (!rel) return true; // the source root itself
    const segments = rel.split(sep);
    if (segments.length === 1) {
      if (segments[0] === "test") return false;
      if (NONSHIPPED_TOP_LEVEL_FILES.has(segments[0])) return false;
    }
    return true;
  };
}

export async function applyBundle({ lock, pluginsDir: dir, expectedId, flattenToRoot = false }) {
  const entry = lock[expectedId];
  if (!entry) throw new Error(`bundle lock has no entry for ${expectedId}`);
  // Relative sources resolve against the repo root (the lock file's home),
  // never the invoking process CWD.
  const src = resolve(repoRoot, entry.source);
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`source missing: ${src}`);
  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  if (manifest.id !== expectedId) throw new Error(`manifest id ${manifest.id} != ${expectedId}`);
  if (manifest.version !== entry.version) throw new Error(`version mismatch: ${manifest.version} != ${entry.version}`);
  if (entry.sha256) {
    const hash = createHash("sha256").update(readFileSync(join(src, "manifest.json"))).digest("hex");
    if (hash !== entry.sha256) throw new Error(`sha256 mismatch for ${expectedId} manifest`);
  }
  // Design G5: offline pre-provisioned install — a bundle without the platform
  // wheelhouse would break first-run setup, so its absence is a hard error.
  const wheelhouse = join(src, "wheelhouse", `${platform()}-${arch()}`);
  if (!existsSync(wheelhouse)) {
    throw new Error(
      `wheelhouse missing for ${platform()}-${arch()} — run 'npm run build:wheelhouse' in the plugin repo`,
    );
  }
  const dest = flattenToRoot ? dir : join(dir, expectedId);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: makeCopyFilter(src) });
  return { copied: true, id: expectedId, version: entry.version, dest };
}

// Packaging-time tripwire: the copied plugin footprint must stay under the
// release ceiling (75 MiB — formerly enforced by the bundled-plugin test).
const BUNDLE_SIZE_CEILING = 75 * 1024 * 1024;

function dirSizeSync(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeSync(full);
    else total += statSync(full).size;
  }
  return total;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  mkdirSync(pluginsDir, { recursive: true });
  for (const id of Object.keys(lock)) {
    // The ppt-master integration lives OUTSIDE the plugins dir (ADR 0041 v3:
    // loaded by lifecycle as an integrated module, not registered by
    // host-core) — its destination is resources/ppt-master.
    if (id === "laboflow.ppt-master") {
      // Integrated module: content lands DIRECTLY at resources/ppt-master
      // (repo-root-of-plugin), not a nested <id> subdir.
      const report = await applyBundle({ lock, pluginsDir: integratedDir, expectedId: id, flattenToRoot: true });
      console.log(`bundled ${report.id}@${report.version} -> ${report.dest}`);
      continue;
    }
    const report = await applyBundle({ lock, pluginsDir, expectedId: id });
    console.log(`bundled ${report.id}@${report.version} -> ${report.dest}`);
  }
  // Ceiling covers every fetched tree (integrated + any future bundled ids).
  const total = Object.keys(lock).reduce(
    (sum, id) => sum + dirSizeSync(id === "laboflow.ppt-master" ? integratedDir : join(pluginsDir, id)),
    0,
  );
  if (total > BUNDLE_SIZE_CEILING) {
    console.error(
      `bundled plugin footprint is ${(total / 1048576).toFixed(1)} MiB — exceeds the ` +
        `${BUNDLE_SIZE_CEILING / 1048576} MiB release ceiling; trim the plugin source or wheelhouse`,
    );
    process.exitCode = 1;
  }
}
