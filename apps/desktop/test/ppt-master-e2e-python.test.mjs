/**
 * REAL Python integration for the PPT-Master runtime channel.
 *
 * Gated behind PPT_IT=1 (runs locally or on an opt-in CI job with a pip/uv
 * cache): builds an actual venv from requirements-laboflow.txt, asserts the
 * AGPL/GPL blacklist, and runs one upstream script end-to-end. Everything
 * here is a no-op (pass-through) without the flag so the default desktop
 * suite stays hermetic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectRuntime,
  ensureRuntime,
  findForbiddenDistributions,
  freezeDistributions,
  runVendoredScript,
  skillRoot,
} from "../resources/plugins/laboflow.slides/lib/ppt-runtime.js";

const REAL_PLUGIN_DIR = new URL(
  "../resources/plugins/laboflow.slides/",
  import.meta.url,
).pathname.replace(/\/$/, "");
const IT_ENABLED = process.env.PPT_IT === "1";
const options = { skip: IT_ENABLED ? false : "PPT_IT=1 未启用：真机集成测试跳过" };

test(
  "real setup: fresh venv → requirements → guard → ready within the time budget",
  { skip: options.skip },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ppt-it-"));
    const startedAt = Date.now();
    const logs = [];
    const status = await ensureRuntime({ pluginDir: REAL_PLUGIN_DIR, dataDir }, (line) => logs.push(line));
    const elapsedMinutes = (Date.now() - startedAt) / 60_000;
    assert.equal(status.stage, "ready");
    assert.ok(
      elapsedMinutes <= 8,
      `setup must finish within 8 minutes on a direct connection, took ${elapsedMinutes.toFixed(1)}`,
    );
  },
  16 * 60_000,
);

test(
  "real runtime: freeze blacklist is empty and the vendored checker runs",
  { skip: options.skip },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ppt-it2-"));
    // Reuse whatever the previous test built by pointing at the same layout:
    // build here if absent (idempotent when the first test already ran).
    const pre = await detectRuntime({ pluginDir: REAL_PLUGIN_DIR, dataDir });
    if (pre.stage !== "ready") {
      await ensureRuntime({ pluginDir: REAL_PLUGIN_DIR, dataDir }, () => {});
    }
    const frozen = await freezeDistributions({ pluginDir: REAL_PLUGIN_DIR, dataDir });
    assert.ok(Array.isArray(frozen) && frozen.length > 0, "pip freeze must list packages");
    assert.deepEqual(
      findForbiddenDistributions(frozen),
      [],
      `AGPL/GPL blacklist must be empty, got: ${findForbiddenDistributions(frozen).join(", ")}`,
    );
    const checker = join(skillRoot(REAL_PLUGIN_DIR), "scripts", "svg_quality_checker.py");
    const run = await runVendoredScript(
      { pluginDir: REAL_PLUGIN_DIR, dataDir },
      "scripts/svg_quality_checker.py",
      ["--help"],
      { timeoutMs: 120_000 },
    );
    assert.equal(run.code, 0, `checker --help must exit 0 via ${checker}`);
  },
  16 * 60_000,
);
