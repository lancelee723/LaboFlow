#!/usr/bin/env node
/**
 * Build an offline wheelhouse for the PPT-Master runtime (air-gapped orgs).
 *
 * Downloads the trimmed MIT-only requirements into a platform directory you
 * can ship to machines without network access. Point the Slides plugin
 * setting "offlineWheelhouse" at that directory: installs then run with
 * --no-index --find-links (the mirror is ignored).
 *
 * Usage:  node scripts/make-ppt-wheelhouse.mjs [output-dir]
 * Default output: ./ppt-wheelhouse-<platform>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requirements = join(
  root,
  "apps/desktop/resources/plugins/laboflow.slides/vendored/ppt-master/requirements-laboflow.txt",
);
const out = resolve(process.argv[2] || `ppt-wheelhouse-${platform()}-${arch()}`);

if (!existsSync(requirements)) {
  console.error(`requirements not found: ${requirements}`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const uv = spawnSync("uv", ["pip", "download", "-r", requirements, "-d", out], {
  stdio: "inherit",
});
if (uv.status !== 0) {
  console.error("uv pip download failed; falling back to pip download…");
  const pip = spawnSync("python3", ["-m", "pip", "download", "-r", requirements, "-d", out], {
    stdio: "inherit",
  });
  if (pip.status !== 0) {
    console.error("pip download failed too — check network/python");
    process.exit(1);
  }
}
copyFileSync(requirements, join(out, "requirements-laboflow.txt"));
console.log(`\nwheelhouse ready: ${out}`);
console.log('On the air-gapped machine, set the Slides plugin setting "offlineWheelhouse" to this directory.');
