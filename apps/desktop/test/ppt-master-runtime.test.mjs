import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectRuntime,
  ensureRuntime,
  runVendoredScript,
  skillRoot,
  venvPythonPath,
} from "../resources/plugins/laboflow.slides/lib/ppt-runtime.js";

const PLUGIN_DIR = join(
  "/tmp",
  "laboflow-slides-fixture",
);
// The real vendored skill lives in the repo; resolve relative to the test file.
const REAL_PLUGIN_DIR = new URL("../resources/plugins/laboflow.slides/", import.meta.url).pathname.replace(/\/$/, "");

test("skillRoot points at the vendored ppt-master", () => {
  const root = skillRoot("/plugins/laboflow.slides");
  assert.ok(root.endsWith("vendored/ppt-master") || root.endsWith("vendored\\ppt-master"));
  assert.ok(root.includes("laboflow.slides"));
});

test("runVendoredScript refuses without an installed venv", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "ppt-runtime-empty-"));
  let spawned = false;
  await assert.rejects(
    () =>
      runVendoredScript(
        {
          pluginDir: REAL_PLUGIN_DIR,
          homeDir: emptyHome,
          runner: async () => {
            spawned = true;
            return { code: 0, stdout: "", stderr: "" };
          },
        },
        "scripts/svg_quality_checker.py",
        ["x.svg"],
      ),
    (error) => error.errorCode === "PPT_RUNTIME_NOT_READY",
  );
  assert.equal(spawned, false, "must not spawn before the venv exists");
});

test("detectRuntime maps an AGPL-contaminated venv to guard-failed:agpl", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "ppt-runtime-agpl-"));
  // Simulate the venv existing (a python file at the expected path).
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const pythonPath = venvPythonPath(emptyHome);
  mkdirSync(join(pythonPath, ".."), { recursive: true });
  writeFileSync(pythonPath, "#!/bin/sh\nexit 0\n");
  const { chmodSync } = await import("node:fs");
  chmodSync(pythonPath, 0o755);

  const status = await detectRuntime({
    pluginDir: REAL_PLUGIN_DIR,
    homeDir: emptyHome,
    runner: async (file, args) => {
      assert.ok(args[0].endsWith("laboflow_guard.py"), "guard must run first");
      return {
        code: 2,
        stdout: "",
        stderr: "AGPL guard: fitz is importable but must not be installed",
      };
    },
  });
  assert.equal(status.stage, "guard-failed:agpl");
  assert.match(status.diag ?? "", /fitz/);
});

test("detectRuntime returns ready when guard and pip check pass", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "ppt-runtime-ok-"));
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  const pythonPath = venvPythonPath(emptyHome);
  mkdirSync(join(pythonPath, ".."), { recursive: true });
  writeFileSync(pythonPath, "#!/bin/sh\nexit 0\n");
  chmodSync(pythonPath, 0o755);

  const calls = [];
  const status = await detectRuntime({
    pluginDir: REAL_PLUGIN_DIR,
    homeDir: emptyHome,
    runner: async (file, args) => {
      calls.push(args.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(status.stage, "ready");
  assert.equal(status.pythonPath, pythonPath);
  assert.ok(calls.some((call) => call.includes("laboflow_guard.py")), "guard ran");
  assert.ok(calls.some((call) => call.includes("pip")), "pip check ran");
});

test("ensureRuntime creates the venv, installs the laboflow subset and passes the guard", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "ppt-runtime-nopy-"));
  const spawned = [];
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
  const status = await ensureRuntime({
    pluginDir: REAL_PLUGIN_DIR,
    homeDir: emptyHome,
    runner: async (file, args) => {
      spawned.push([file, ...args].join(" "));
      // Simulate `python3 -m venv` producing an interpreter on disk.
      if (args[0] === "-m" && args[1] === "venv") {
        const pythonPath = venvPythonPath(emptyHome);
        mkdirSync(join(pythonPath, ".."), { recursive: true });
        writeFileSync(pythonPath, "#!/bin/sh\nexit 0\n");
        chmodSync(pythonPath, 0o755);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(status.stage, "ready");
  assert.ok(spawned.some((call) => call.includes("-m venv")), "venv created");
  assert.ok(
    spawned.some((call) => call.includes("requirements-laboflow.txt")),
    "laboflow requirements subset installed",
  );
  assert.ok(
    !spawned.some((call) => call.includes("requirements.txt ") || call.endsWith("requirements.txt")),
    "upstream requirements (contains PyMuPDF) must never be installed",
  );
});
