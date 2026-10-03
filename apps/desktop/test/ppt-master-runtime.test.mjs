import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseInstaller,
  detectRuntime,
  ensureRuntime,
  findForbiddenDistributions,
  isSupportedPython,
  migrateLegacyRuntime,
  parsePythonVersion,
  resolveRuntimeRoot,
  runVendoredScript,
  skillRoot,
  venvDirPath,
  venvPythonPath,
} from "../resources/plugins/laboflow.slides/lib/ppt-runtime.js";

// The real vendored skill lives in the repo; resolve relative to the test file.
const REAL_PLUGIN_DIR = fileURLToPath(new URL("../resources/plugins/laboflow.slides/", import.meta.url));

const tmpHome = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** Plant a fake venv interpreter at the canonical location for deps.dataDir. */
function plantVenv(dataDir) {
  const pythonPath = venvPythonPath(resolveRuntimeRoot({ dataDir }));
  mkdirSync(join(pythonPath, ".."), { recursive: true });
  writeFileSync(pythonPath, "#!/bin/sh\nexit 0\n");
  chmodSync(pythonPath, 0o755);
  return pythonPath;
}

test("skillRoot points at the vendored ppt-master", () => {
  const root = skillRoot("/plugins/laboflow.slides");
  assert.ok(root.endsWith("vendored/ppt-master") || root.endsWith("vendored\\ppt-master"));
  assert.ok(root.includes("laboflow.slides"));
});

test("runtime root prefers the plugin data dir over the legacy home", () => {
  const root = resolveRuntimeRoot({ dataDir: "/data/plugins/laboflow.slides" });
  assert.ok(root.endsWith(join("laboflow.slides", "ppt-runtime")) || root.includes("ppt-runtime"));
  assert.ok(root.includes("laboflow.slides"), "canonical root must live under the data dir");
  const legacy = resolveRuntimeRoot({ homeDir: "/home/x" });
  assert.match(legacy, /\.laboflow/);
});

test("migrateLegacyRuntime moves the legacy venv into the data dir", () => {
  const home = tmpHome("ppt-runtime-legacy-");
  const dataDir = tmpHome("ppt-runtime-data-");
  const legacyPython = venvPythonPath(resolveRuntimeRoot({ homeDir: home }));
  mkdirSync(join(legacyPython, ".."), { recursive: true });
  writeFileSync(legacyPython, "#!/bin/sh\nexit 0\n");

  const result = migrateLegacyRuntime({ dataDir, homeDir: home });
  assert.equal(result.migrated, true);
  assert.ok(existsSync(venvPythonPath(resolveRuntimeRoot({ dataDir }))), "venv now at canonical path");
  assert.ok(!existsSync(venvDirPath(resolveRuntimeRoot({ homeDir: home }))), "legacy venv gone");
});

test("parsePythonVersion and isSupportedPython gate the interpreter floor", () => {
  assert.deepEqual(parsePythonVersion("Python 3.13.1"), [3, 13, 1]);
  assert.deepEqual(parsePythonVersion("Python 3.9.7"), [3, 9, 7]);
  assert.equal(parsePythonVersion("no version here"), null);
  assert.equal(isSupportedPython([3, 10, 0]), true);
  assert.equal(isSupportedPython([3, 13, 1]), true);
  assert.equal(isSupportedPython([3, 9, 7]), false);
  assert.equal(isSupportedPython([4, 0, 0]), false);
  assert.equal(isSupportedPython(null), false);
});

test("chooseInstaller covers the bootstrap decision matrix", () => {
  // uv wins whenever present, regardless of system python.
  assert.equal(chooseInstaller({ uvOk: true, pythonVersion: [3, 13, 1] }).strategy, "uv");
  assert.equal(chooseInstaller({ uvOk: true, pythonVersion: [3, 9, 0] }).strategy, "uv");
  assert.equal(chooseInstaller({ uvOk: true, pythonVersion: null }).strategy, "uv");
  // No uv: system python must be >=3.10 <4.0.
  assert.equal(chooseInstaller({ uvOk: false, pythonVersion: [3, 13, 1] }).strategy, "python");
  assert.equal(chooseInstaller({ uvOk: false, pythonVersion: [3, 10, 0] }).strategy, "python");
  assert.equal(chooseInstaller({ uvOk: false, pythonVersion: [3, 9, 7] }).strategy, "missing-python");
  assert.equal(chooseInstaller({ uvOk: false, pythonVersion: [4, 1, 0] }).strategy, "missing-python");
  assert.equal(chooseInstaller({ uvOk: false, pythonVersion: null }).strategy, "missing-python");
});

test("runVendoredScript refuses without an installed venv", async () => {
  const dataDir = tmpHome("ppt-runtime-empty-");
  let spawned = false;
  await assert.rejects(
    () =>
      runVendoredScript(
        {
          pluginDir: REAL_PLUGIN_DIR,
          dataDir,
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

test("runVendoredScript injects the PDF-disable env and uses the venv interpreter", async () => {
  const dataDir = tmpHome("ppt-runtime-run-");
  const pythonPath = plantVenv(dataDir);
  let seen;
  await runVendoredScript(
    {
      pluginDir: REAL_PLUGIN_DIR,
      dataDir,
      runner: async (file, args, options) => {
        seen = { file, args, env: options.env };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    "scripts/svg_quality_checker.py",
    ["x.svg"],
  );
  assert.equal(seen.file, pythonPath, "must run with the venv interpreter");
  assert.equal(seen.env.PPT_MASTER_DISABLE_PDF, "1");
  assert.ok(seen.args[0].endsWith("svg_quality_checker.py"));
});

test("detectRuntime maps an AGPL-contaminated venv to guard-failed:agpl", async () => {
  const dataDir = tmpHome("ppt-runtime-agpl-");
  plantVenv(dataDir);
  const status = await detectRuntime({
    pluginDir: REAL_PLUGIN_DIR,
    dataDir,
    runner: async () => ({
      code: 2,
      stdout: "",
      stderr: "AGPL guard: fitz is importable but must not be installed",
    }),
  });
  assert.equal(status.stage, "guard-failed:agpl");
  assert.match(status.diag ?? "", /fitz/);
  assert.match(status.doctor ?? "", /删除|venv/);
});

test("detectRuntime returns ready when guard and pip check pass", async () => {
  const dataDir = tmpHome("ppt-runtime-ok-");
  const pythonPath = plantVenv(dataDir);
  const calls = [];
  const status = await detectRuntime({
    pluginDir: REAL_PLUGIN_DIR,
    dataDir,
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

test("ensureRuntime (no uv, python 3.13) creates the venv and installs the MIT subset", async () => {
  const dataDir = tmpHome("ppt-runtime-setup-");
  const spawned = [];
  const status = await ensureRuntime(
    {
      pluginDir: REAL_PLUGIN_DIR,
      dataDir,
      pipMirror: "https://pypi.tuna.tsinghua.edu.cn/simple",
      runner: async (file, args, options) => {
        spawned.push([file, ...args].join(" "));
        if (file === "uv") return { code: 1, stdout: "", stderr: "uv absent" };
        if (file === "python3" && args[0] === "--version") {
          return { code: 0, stdout: "Python 3.13.1\n", stderr: "" };
        }
        if (args[0] === "-m" && args[1] === "venv") {
          plantVenv(dataDir);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("install")) {
          assert.ok(options.env.PIP_INDEX_URL?.includes("tuna"), "mirror env injected for installs");
        }
        // guard / pip check / pip install all succeed
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    () => {},
  );
  assert.equal(status.stage, "ready");
  assert.ok(spawned.some((call) => call.includes("-m venv")), "venv created");
  assert.ok(!spawned.some((call) => call.includes("uv venv")), "uv path not taken without uv");
  assert.ok(
    spawned.some((call) => call.includes("requirements-laboflow.txt")),
    "laboflow requirements subset installed",
  );
  assert.ok(
    !spawned.some((call) => /requirements\.txt( |$)/.test(call)),
    "upstream requirements (contains PyMuPDF) must never be installed",
  );
});

test("ensureRuntime uses uv venv when uv is available", async () => {
  const dataDir = tmpHome("ppt-runtime-uv-");
  const spawned = [];
  const status = await ensureRuntime(
    {
      pluginDir: REAL_PLUGIN_DIR,
      dataDir,
      runner: async (file, args, options) => {
        spawned.push([file, ...args].join(" "));
        if (file === "uv" && args[0] === "--version") return { code: 0, stdout: "uv 1.0\n", stderr: "" };
        if (file === "uv" && args[0] === "venv") {
          assert.equal(options.env.UV_INDEX_URL, undefined, "no mirror configured → no index override");
          plantVenv(dataDir);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    () => {},
  );
  assert.equal(status.stage, "ready");
  assert.ok(spawned.some((call) => call.startsWith("uv venv")), "uv venv used");
  assert.ok(!spawned.some((call) => call.includes("-m venv")), "system python venv not used");
});

test("ensureRuntime refuses an unsupported system python without spawning installs", async () => {
  const dataDir = tmpHome("ppt-runtime-oldpy-");
  const spawned = [];
  const status = await ensureRuntime(
    {
      pluginDir: REAL_PLUGIN_DIR,
      dataDir,
      runner: async (file, args) => {
        spawned.push([file, ...args].join(" "));
        if (file === "uv") return { code: 1, stdout: "", stderr: "absent" };
        if (file === "python3" && args[0] === "--version") {
          return { code: 0, stdout: "Python 3.9.7\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    () => {},
  );
  assert.equal(status.stage, "missing-python");
  assert.match(status.diag, /3\.9\.7|3\.10/);
  assert.ok(!spawned.some((call) => call.includes("-m venv")), "no venv with an unsupported python");
  assert.ok(!spawned.some((call) => call.includes("pip")), "no installs with an unsupported python");
});

test("offline wheelhouse switches installs to --no-index --find-links", async () => {
  const dataDir = tmpHome("ppt-runtime-wheel-");
  plantVenv(dataDir);
  const spawned = [];
  const status = await ensureRuntime(
    {
      pluginDir: REAL_PLUGIN_DIR,
      dataDir,
      wheelhouseDir: "/opt/laboflow/wheelhouse",
      runner: async (file, args) => {
        spawned.push([file, ...args].join(" "));
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    () => {},
  );
  assert.equal(status.stage, "ready");
  assert.ok(
    spawned.some((call) => call.includes("--no-index") && call.includes("/opt/laboflow/wheelhouse")),
    "wheelhouse path must reach the installer",
  );
  assert.ok(!spawned.some((call) => call.includes("-m pip install") && !call.includes("--find-links")), "pip path also pinned to the wheelhouse");
});

test("forbidden-distribution blacklist catches AGPL/GPL packages in pip freeze", () => {
  const frozen = [
    "attrs==25.3.0",
    "PyMuPDF==1.24.0",
    "edge-tts==7.2.8",
    "flask==3.1.0",
    "python-pptx==1.0.2",
    "ebooklib==0.18",
  ];
  assert.deepEqual(
    findForbiddenDistributions(frozen).sort(),
    ["ebooklib", "edge-tts", "flask", "pymupdf"],
  );
  assert.deepEqual(findForbiddenDistributions(["python-pptx==1.0.2", "lxml==5.0"]), []);
  assert.deepEqual(findForbiddenDistributions(null), []);
});
