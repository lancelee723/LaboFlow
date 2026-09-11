/**
 * PPT-Master runtime manager (module 06 L2, plans T56.4/T56.6).
 *
 * Owns the isolated Python environment for the vendored skill: a dedicated
 * venv built from `requirements-laboflow.txt` (PyMuPDF/pandoc REMOVED —
 * AGPL/GPL guard) plus a startup assertion. System Python is used only to
 * bootstrap the venv; the vendored scripts always run with the venv
 * interpreter, and the guard refuses a contaminated environment.
 *
 * No `pi.*` access here — testable headlessly with injected runners.
 * Plain ESM JavaScript (plugin host loads this file without a TS loader).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {"ready"|"missing-python"|"venv-missing"|"deps-missing"|"guard-failed"|"guard-failed:agpl"|"error"} PptRuntimeStage
 *
 * @typedef {object} PptRuntimeStatus
 * @property {PptRuntimeStage} stage
 * @property {string} [pythonPath]
 * @property {string} venvPath
 * @property {string} [diag]
 *
 * @typedef {object} RunResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 *
 * @typedef {(file: string, args: string[], options: {cwd?: string, env?: Record<string, string|undefined>, timeoutMs: number}) => Promise<RunResult>} Runner
 *
 * @typedef {object} PptRuntimeDeps
 * @property {Runner} [runner]
 * @property {string} pluginDir
 * @property {string} [homeDir]
 * @property {string} [pipMirror]
 */

export const PPT_MASTER_REQUIREMENTS = "requirements-laboflow.txt";
export const PPT_MASTER_GUARD = join("scripts", "laboflow_guard.py");
export const FORBIDDEN_MODULES = ["PyMuPDF", "fitz", "pymupdf"];

export function pptRuntimeRoot(homeDir = homedir()) {
  return join(homeDir, ".laboflow", "ppt-runtime");
}

export function venvPythonPath(homeDir = homedir()) {
  return join(
    pptRuntimeRoot(homeDir),
    "venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
}

export function skillRoot(pluginDir) {
  return join(pluginDir, "vendored", "ppt-master");
}

export const execRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const rawCode = (error || {})?.code;
        const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
        if (error && code === 0) reject(error);
        else resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/** Run one vendored script with the isolated venv interpreter. */
export async function runVendoredScript(deps, scriptRelPath, args, options = {}) {
  const pythonPath = venvPythonPath(deps.homeDir);
  if (!existsSync(pythonPath)) {
    throw Object.assign(
      new Error("PPT-Master 运行环境未就绪：请先运行 ppt_master_setup 安装 Python 环境"),
      { errorCode: "PPT_RUNTIME_NOT_READY" },
    );
  }
  const scriptPath = join(skillRoot(deps.pluginDir), scriptRelPath);
  const result = await (deps.runner ?? execRunner)(
    pythonPath,
    [scriptPath, ...args],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
      env: { PPT_MASTER_DISABLE_PDF: "1", PYTHONIOENCODING: "utf-8" },
    },
  );
  return { ...result, pythonPath };
}

/** The startup assertion: no AGPL deps, attribution intact. */
export async function runGuard(deps) {
  return (deps.runner ?? execRunner)(
    venvPythonPath(deps.homeDir),
    [join(skillRoot(deps.pluginDir), PPT_MASTER_GUARD)],
    { timeoutMs: 30_000, env: { PYTHONIOENCODING: "utf-8" } },
  );
}

export async function detectRuntime(deps) {
  const venvRoot = pptRuntimeRoot(deps.homeDir);
  const pythonPath = venvPythonPath(deps.homeDir);
  const runner = deps.runner ?? execRunner;
  if (!existsSync(pythonPath)) {
    return { stage: "venv-missing", venvPath: venvRoot, diag: "尚未创建隔离 Python 环境" };
  }
  const guard = await runGuard(deps).catch((error) => ({
    code: 1,
    stdout: "",
    stderr: String(error),
  }));
  if (guard.code !== 0) {
    const text = `${guard.stdout}\n${guard.stderr}`;
    const agpl = FORBIDDEN_MODULES.some((name) => text.includes(name));
    return {
      stage: agpl ? "guard-failed:agpl" : "guard-failed",
      pythonPath,
      venvPath: venvRoot,
      diag: text.trim().slice(0, 800),
    };
  }
  const pipCheck = await runner(pythonPath, ["-m", "pip", "check"], {
    timeoutMs: 60_000,
    env: {},
  }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
  if (pipCheck.code !== 0) {
    return {
      stage: "deps-missing",
      pythonPath,
      venvPath: venvRoot,
      diag: `${pipCheck.stdout}${pipCheck.stderr}`.trim().slice(0, 800),
    };
  }
  return { stage: "ready", pythonPath, venvPath: venvRoot };
}

/**
 * Full setup: bootstrap the venv from any system Python 3.10+, install the
 * LaboFlow requirements subset, then assert the guard.
 */
export async function ensureRuntime(deps, onLog) {
  const runner = deps.runner ?? execRunner;
  const log = (line) => onLog?.(line);
  const venvRoot = pptRuntimeRoot(deps.homeDir);
  const venvDir = join(venvRoot, "venv");
  const pythonPath = venvPythonPath(deps.homeDir);
  const requirements = join(skillRoot(deps.pluginDir), PPT_MASTER_REQUIREMENTS);

  const bootstrap = await runner("python3", ["--version"], { timeoutMs: 15_000, env: {} }).catch(
    () => undefined,
  );
  if (!bootstrap || bootstrap.code !== 0) {
    return {
      stage: "missing-python",
      venvPath: venvRoot,
      diag: "未找到系统 python3（需要 3.10+）。请安装 Python 或 uv 后重试。",
    };
  }
  log(`bootstrap: ${bootstrap.stdout.trim()}`);

  if (!existsSync(pythonPath)) {
    log("creating venv…");
    const created = await runner("python3", ["-m", "venv", venvDir], {
      timeoutMs: 120_000,
      env: {},
    }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
    if (created.code !== 0) {
      return {
        stage: "error",
        venvPath: venvRoot,
        diag: `venv 创建失败：${created.stderr || created.stdout}`.slice(0, 800),
      };
    }
  }

  log("installing requirements (this can take a few minutes)…");
  const mirrorEnv = deps.pipMirror ? { PIP_INDEX_URL: deps.pipMirror } : {};
  const installed = await runner(
    pythonPath,
    ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements],
    { timeoutMs: 15 * 60 * 1000, env: mirrorEnv },
  ).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
  if (installed.code !== 0) {
    return {
      stage: "deps-missing",
      pythonPath,
      venvPath: venvRoot,
      diag: `依赖安装失败：${installed.stderr || installed.stdout}`.slice(0, 800),
    };
  }

  const status = await detectRuntime(deps);
  log(`runtime: ${status.stage}`);
  return status;
}
