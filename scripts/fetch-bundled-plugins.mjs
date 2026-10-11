#!/usr/bin/env node
/**
 * Fetch pinned bundled plugins listed in apps/desktop/plugins.bundle.json
 * into apps/desktop/resources/plugins/ before packaging (ADR 0041).
 * `source` is a local directory (this iteration) or an http(s) .zip URL.
 * Validates manifest id + version; refuses anything else.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repoRoot, "apps/desktop/plugins.bundle.json");
const pluginsDir = join(repoRoot, "apps/desktop/resources/plugins");

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

export async function applyBundle({ lock, pluginsDir: dir, expectedId }) {
  const entry = lock[expectedId];
  if (!entry) throw new Error(`bundle lock has no entry for ${expectedId}`);
  const src = resolve(entry.source);
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`source missing: ${src}`);
  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  if (manifest.id !== expectedId) throw new Error(`manifest id ${manifest.id} != ${expectedId}`);
  if (manifest.version !== entry.version) throw new Error(`version mismatch: ${manifest.version} != ${entry.version}`);
  if (entry.sha256) {
    const hash = createHash("sha256").update(readFileSync(join(src, "manifest.json"))).digest("hex");
    if (hash !== entry.sha256) throw new Error(`sha256 mismatch for ${expectedId} manifest`);
  }
  const dest = join(dir, expectedId);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(src, dest, { recursive: true, filter: makeCopyFilter(src) });
  return { copied: true, id: expectedId, version: entry.version, dest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  mkdirSync(pluginsDir, { recursive: true });
  for (const id of Object.keys(lock)) {
    const report = await applyBundle({ lock, pluginsDir, expectedId: id });
    console.log(`bundled ${report.id}@${report.version} -> ${report.dest}`);
  }
}
