#!/usr/bin/env node
/**
 * Build an offline wheelhouse for the PPT-Master runtime (standalone
 * plugin repo laboflow-ppt-master).
 *
 * Downloads the trimmed MIT-only requirements into a directory that installs
 * offline with --no-index --find-links. The wheelhouse rides inside the
 * plugin package itself: LaboFlow consumes this repo as a release source
 * (tagged zip, pinned via plugins.bundle.json), so bundled wheels travel
 * with the plugin and are auto-detected at runtime. Two consumers:
 *   - Bundled packaging: `--bundled` writes
 *     wheelhouse/<platform>-<arch>/ (gitignored) at the repo root; the
 *     released plugin archive ships it inside the plugin.
 *   - Air-gapped orgs: an explicit output dir, referenced manually.
 *
 * Wheels resolve for CPython 3.12 (--python-version 312, --only-binary so
 * sdists can never sneak in) because ppt-runtime pins `uv venv --python
 * 3.12`; pure-Python wheels are version-independent. A fallback pip install
 * from a different interpreter minor version stays online (mirror setting
 * applies).
 *
 * Usage:  node scripts/make-ppt-wheelhouse.mjs [--bundled] [output-dir]
 * Default output: ./ppt-wheelhouse-<platform>-<arch>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requirements = join(root, "vendored/ppt-master/requirements-laboflow.txt");
/** Must match the `uv venv --python` pin in lib/ppt-runtime.js. */
const PYTHON_VERSION = "3.12";

const argv = process.argv.slice(2);
const bundled = argv.includes("--bundled");
const outArg = argv.find((a) => !a.startsWith("--"));
const out = bundled
  ? join(root, "wheelhouse", `${platform()}-${arch()}`)
  : resolve(outArg || `ppt-wheelhouse-${platform()}-${arch()}`);

if (!existsSync(requirements)) {
  console.error(`requirements not found: ${requirements}`);
  process.exit(1);
}
// Rebuild from a clean directory so stale wheels from other python versions
// can never survive into the bundle.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// `uv pip download` does not exist in uv; pip resolves wheels for a target
// interpreter version without that interpreter being installed.
const pip = spawnSync(
  "python3",
  [
    "-m",
    "pip",
    "download",
    "--python-version",
    PYTHON_VERSION.replace(".", ""),
    "--only-binary=:all:",
    "-r",
    requirements,
    "-d",
    out,
  ],
  { stdio: "inherit" },
);
if (pip.status !== 0) {
  console.error(`pip download failed — check network/python (target CPython ${PYTHON_VERSION})`);
  process.exit(1);
}
copyFileSync(requirements, join(out, "requirements-laboflow.txt"));
const wheels = readdirSync(out).filter((f) => f.endsWith(".whl"));
const totalBytes = wheels.reduce((acc, f) => acc + statSync(join(out, f)).size, 0);
console.log(`\nwheelhouse ready: ${out}`);
console.log(`wheels: ${wheels.length} (${(totalBytes / 1048576).toFixed(1)} MiB, CPython ${PYTHON_VERSION})`);
