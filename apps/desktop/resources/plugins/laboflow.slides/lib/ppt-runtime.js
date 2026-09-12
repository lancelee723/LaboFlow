/**
 * PPT-Master runtime manager (module 06 L2, DEVPLAN Phase A).
 *
 * Owns the isolated Python environment for the vendored skill: a dedicated
 * venv built from `requirements-laboflow.txt` (PyMuPDF/pandoc/edge-tts/
 * ebooklib/flask REMOVED — AGPL/GPL guard) plus a startup assertion. The
 * vendored scripts always run with the venv interpreter; the guard refuses a
 * contaminated environment.
 *
 * Canonical venv home is the plugin data directory (Pi storage isolation);
 * the legacy `~/.laboflow/ppt-runtime` location is migrated on first setup.
 * Installer preference: uv (fast, can fetch a managed interpreter) → system
 * python3 (version must parse to >=3.10 <4.0 — a bare "python3 exists" probe
 * once let a 3.9 interpreter through). No `pi.*` access here — testable
 * headlessly with injected runners. Plain ESM JavaScript (plugin host loads
 * this file without a TS loader).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PPT_MASTER_REQUIREMENTS = "requirements-laboflow.txt";
export const PPT_MASTER_GUARD = join("scripts", "laboflow_guard.py");
export const FORBIDDEN_MODULES = ["PyMuPDF", "fitz", "pymupdf"];

/** pip freeze must never contain these — AGPL/GPL or deliberately dropped. */
export const FORBIDDEN_DISTRIBUTIONS = [
  "PyMuPDF",
  "fitz",
  "pymupdf",
  "pandoc",
  "pypandoc",
  "edge-tts",
  "ebooklib",
  "flask",
];

export function pptRuntimeRoot(homeDir = homedir()) {
  return join(homeDir, ".laboflow", "ppt-runtime");
}

export function legacyRuntimeRoot(homeDir = homedir()) {
  return pptRuntimeRoot(homeDir);
}

/** Canonical root: plugin data dir when available, legacy home otherwise. */
export function resolveRuntimeRoot(deps) {
  if (deps?.dataDir) return join(deps.dataDir, "ppt-runtime");
  return pptRuntimeRoot(deps?.homeDir);
}

export function venvDirPath(root) {
  return join(root, "venv");
}

export function venvPythonPath(root) {
  return join(
    venvDirPath(root),
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
}

export function skillRoot(pluginDir) {
  return join(pluginDir, "vendored", "ppt-master");
}

/**
 * First-run migration: the venv used to live under ~/.laboflow; move it into
 * the plugin data dir. No-op when the canonical venv already exists or there
 * is nothing legacy to move.
 */
export function migrateLegacyRuntime(deps) {
  if (!deps?.dataDir) return { migrated: false, reason: "no-data-dir" };
  const canonical = venvPythonPath(resolveRuntimeRoot(deps));
  if (existsSync(canonical)) return { migrated: false, reason: "already-present" };
  const legacyPython = venvPythonPath(pptRuntimeRoot(deps.homeDir ?? homedir()));
  if (!existsSync(legacyPython)) return { migrated: false, reason: "no-legacy" };
  try {
    mkdirSync(resolveRuntimeRoot(deps), { recursive: true });
    renameSync(venvDirPath(pptRuntimeRoot(deps.homeDir ?? homedir())), venvDirPath(resolveRuntimeRoot(deps)));
    return { migrated: true };
  } catch (error) {
    return { migrated: false, reason: `rename-failed: ${error?.message ?? error}` };
  }
}

/** "Python 3.13.1" → [3, 13, 1]; null when unparseable. */
export function parsePythonVersion(stdout) {
  const match = String(stdout ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Supported: 3.10 ≤ v < 4.0 (upstream floor, documented in README). */
export function isSupportedPython(version) {
  if (!version) return false;
  const [major, minor] = version;
  return major === 3 && minor >= 10;
}

/**
 * Installer decision (pure — the unit-testable bootstrap matrix).
 * uv wins when present: `uv venv` can provision a managed interpreter, so no
 * system python is required. Otherwise system python3 must parse to a
 * supported version. Anything else is missing-python with a doctor hint.
 */
export function chooseInstaller({ uvOk, pythonVersion }) {
  if (uvOk) return { strategy: "uv", reason: "uv available" };
  if (isSupportedPython(pythonVersion)) return { strategy: "python", reason: `system python ${pythonVersion.join(".")}` };
  if (pythonVersion) {
    return {
      strategy: "missing-python",
      reason: `系统 python3 版本 ${pythonVersion.join(".")} 过低（需要 ≥3.10）。请安装 Python 3.10+ 或 uv 后重试。`,
    };
  }
  return {
    strategy: "missing-python",
    reason: "未找到可用的 python3 或 uv（需要 Python 3.10+）。请安装后重试。",
  };
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
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const rawCode = (error || {})?.code;
        const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
        if (error && code === 0) reject(error);
        else resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/** Mirror settings: PIP_INDEX_URL for pip, UV_INDEX_URL (and PIP's) for uv. */
function mirrorEnv(pipMirror) {
  return pipMirror ? { PIP_INDEX_URL: pipMirror, UV_INDEX_URL: pipMirror } : {};
}

/** Run one vendored script with the isolated venv interpreter. */
export async function runVendoredScript(deps, scriptRelPath, args, options = {}) {
  const root = resolveRuntimeRoot(deps);
  const pythonPath = venvPythonPath(root);
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
      signal: options.signal,
      env: { PPT_MASTER_DISABLE_PDF: "1", PYTHONIOENCODING: "utf-8" },
    },
  );
  return { ...result, pythonPath };
}

/** The startup assertion: no AGPL deps, attribution intact. */
export async function runGuard(deps) {
  return (deps.runner ?? execRunner)(
    venvPythonPath(resolveRuntimeRoot(deps)),
    [join(skillRoot(deps.pluginDir), PPT_MASTER_GUARD)],
    { timeoutMs: 30_000, env: { PYTHONIOENCODING: "utf-8" } },
  );
}

/** pip freeze of the venv (blacklist assertions + doctor diagnostics). */
export async function freezeDistributions(deps) {
  const result = await (deps.runner ?? execRunner)(
    venvPythonPath(resolveRuntimeRoot(deps)),
    ["-m", "pip", "freeze", "--all"],
    { timeoutMs: 60_000, env: {} },
  ).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
  if (result.code !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function findForbiddenDistributions(frozen) {
  if (!frozen) return [];
  const hits = [];
  for (const line of frozen) {
    const name = line.split(/[=<>![\s]/)[0]?.toLowerCase();
    if (!name) continue;
    if (FORBIDDEN_DISTRIBUTIONS.some((bad) => bad.toLowerCase() === name)) hits.push(name);
  }
  return hits;
}

/**
 * Five-state inspection: missing-python (no interpreter to build from is
 * reported by setup, not here), venv-missing, guard-failed[:agpl],
 * deps-missing, ready. Adds `doctor` advice per state and `forbidden`
 * distribution hits when checkable.
 */
export async function detectRuntime(deps) {
  const root = resolveRuntimeRoot(deps);
  const pythonPath = venvPythonPath(root);
  const runner = deps.runner ?? execRunner;
  if (!existsSync(pythonPath)) {
    return {
      stage: "venv-missing",
      venvPath: root,
      diag: "尚未创建隔离 Python 环境",
      doctor: "运行 ppt_master_setup 安装（或让助手调用它）",
    };
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
      venvPath: root,
      diag: text.trim().slice(0, 800),
      doctor: agpl
        ? "venv 被 AGPL 依赖污染：删除 venv 目录后重新 ppt_master_setup"
        : "完整性断言失败：查看 diag；必要时删除 venv 后重装",
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
      venvPath: root,
      diag: `${pipCheck.stdout}${pipCheck.stderr}`.trim().slice(0, 800),
      doctor: "依赖不完整：重新运行 ppt_master_setup 修复",
    };
  }
  return { stage: "ready", pythonPath, venvPath: root, doctor: "" };
}

/**
 * Full setup: migrate legacy venv → choose installer (uv preferred, else
 * system python with version validation) → create venv → install the
 * LaboFlow requirements subset (mirror-aware) → assert via detectRuntime.
 */
export async function ensureRuntime(deps, onLog) {
  const runner = deps.runner ?? execRunner;
  const log = (line) => onLog?.(line);
  const signal = deps.signal;
  const root = resolveRuntimeRoot(deps);
  const venvPath = venvDirPath(root);
  const pythonPath = venvPythonPath(root);
  const requirements = join(skillRoot(deps.pluginDir), PPT_MASTER_REQUIREMENTS);
  const env = mirrorEnv(deps.pipMirror);

  const migration = migrateLegacyRuntime(deps);
  if (migration.migrated) log(`migrated legacy venv → ${root}`);

  let useUv = false;
  if (existsSync(pythonPath)) {
    log("venv already present; ensuring requirements…");
    // Prefer uv for installs too when it happens to be available.
    useUv = await runner("uv", ["--version"], { timeoutMs: 5_000, env: {} })
      .then((probe) => !!probe && probe.code === 0)
      .catch(() => false);
  } else {
    const [uvProbe, pyProbe] = await Promise.all([
      runner("uv", ["--version"], { timeoutMs: 5_000, env: {} }).catch(() => undefined),
      runner("python3", ["--version"], { timeoutMs: 15_000, env: {} }).catch(() => undefined),
    ]);
    const uvOk = !!uvProbe && uvProbe.code === 0;
    const pythonVersion = parsePythonVersion(pyProbe?.stdout);
    const choice = chooseInstaller({ uvOk, pythonVersion });
    useUv = choice.strategy === "uv";
    log(`bootstrap: ${choice.strategy} (${choice.reason})`);
    if (choice.strategy === "missing-python") {
      return { stage: "missing-python", venvPath: root, diag: choice.reason, doctor: choice.reason };
    }
    log("creating venv…");
    const created =
      useUv
        ? await runner("uv", ["venv", "--python", "3.12", venvPath], {
            timeoutMs: 600_000,
            env,
            signal,
          }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }))
        : await runner("python3", ["-m", "venv", venvPath], {
            timeoutMs: 120_000,
            env: {},
            signal,
          }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
    if (created.code !== 0) {
      return {
        stage: "error",
        venvPath: root,
        diag: `venv 创建失败：${created.stderr || created.stdout}`.slice(0, 800),
        doctor: "查看 diag；uv 路径可用时优先安装 uv（https://docs.astral.sh/uv/）",
      };
    }
  }

  log("installing requirements (this can take a few minutes)…");
  const uvInstall = () =>
    runner("uv", ["pip", "install", "--python", pythonPath, "-r", requirements], {
      timeoutMs: 15 * 60 * 1000,
      env,
      signal,
    }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));
  const pipInstall = () =>
    runner(pythonPath, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements], {
      timeoutMs: 15 * 60 * 1000,
      env,
      signal,
    }).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }));

  let installed = useUv ? await uvInstall() : await pipInstall();
  if (installed.code !== 0 && useUv) {
    log("uv install failed; falling back to venv pip");
    installed = await pipInstall();
  }
  if (installed.code !== 0) {
    return {
      stage: "deps-missing",
      pythonPath,
      venvPath: root,
      diag: `依赖安装失败：${installed.stderr || installed.stdout}`.slice(0, 800),
      doctor: deps.pipMirror
        ? "镜像源失败：检查 pipMirror 设置或换源后重试"
        : "网络失败：可在插件设置配置 pipMirror 镜像后重试",
    };
  }

  const status = await detectRuntime(deps);
  log(`runtime: ${status.stage}`);
  return status;
}
