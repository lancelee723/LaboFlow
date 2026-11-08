/**
 * Slides — bundled first-party plugin (module 06). Single PPT engine since
 * ADR 0040: the L1 pptxgenjs quick deck was removed (quick-generation
 * quality eroded user trust and duplicated the vendored pipeline's niche);
 * everything routes through PPT-Master.
 *
 * PPT-Master (vendored skill — DEVPLAN Phase A): the skill corpus guides
 * the agent (skills/ppt-master.md thin shell + upstream body); these tools
 * expose only what the agent cannot do itself:
 *   - ppt_master_status: five-state runtime inspection + the {skillDir,
 *     pythonPath} pair the skill preamble requires before any Bash call
 *   - ppt_master_setup: venv bootstrap as a background job (uv preferred,
 *     AGPL-guarded MIT-only subset) — setup exceeds the 110s tool budget.
 *     The runtime is PRE-PROVISIONED at plugin load and packaged installs
 *     install offline from the bundled wheelhouse; first use never waits.
 *   - ppt_job_status: poll background jobs
 *   - ppt_read_doc: read-only whitelist bridge into the vendored corpus
 *     (the agent's Read sandbox cannot reach the app bundle)
 * Phase B adds ppt_script (whitelisted script runner with hard confirm
 * gates) and the stage confirmation tools; the old ppt_quality/finalize/
 * export wrappers are gone — their CLI arg contracts were wrong and
 * ppt_script replaces them with argparse-faithful schemas.
 */

import { open, readFile } from "node:fs/promises";
import { existsSync, fstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { exec as spawnExec } from "node:child_process";
import { join, dirname } from "node:path";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";

import {
  detectRuntime,
  ensureRuntime,
  execRunner,
  findForbiddenDistributions,
  freezeDistributions,
  resolveRuntimeRoot,
  skillRoot,
  venvPythonPath,
} from "./lib/ppt-runtime.js";
import { createJobManager } from "./lib/ppt-jobs.js";
import { listDocDir, MAX_DOC_BYTES, resolveDocEntry } from "./lib/ppt-read-doc.js";
import {
  assertExportAllowed,
  confirmStage,
  deletePage,
  getExportPrefs,
  loadState,
  movePage,
  readStageResult,
  setExportPrefs,
  STAGES,
  submitStage,
} from "./lib/ppt-state.js";
import { budgetVerdict } from "./lib/ppt-estimate.js";
import { PPT_SCRIPTS, planScript, safeToken } from "./lib/ppt-script.js";
import {
  annotationsLogPath,
  countAnnotationRecords,
  lockFilePath,
  PREVIEW_WATCH_MAX_MS,
  previewStatusFor,
} from "./lib/preview-watch.js";

/** FR-PPT-16: best-effort page count from the stage payload — directions
 * carry page lists upstream; fall back to an explicit pageCount field. */
function countStagePages(recommendations) {
  if (!recommendations || typeof recommendations !== "object") return 0;
  if (Number.isFinite(recommendations.pageCount)) return recommendations.pageCount;
  const directions = recommendations.directions ?? recommendations.options ?? [];
  if (!Array.isArray(directions) || !directions.length) return 0;
  const first = directions[0] ?? {};
  if (Array.isArray(first.pages)) return first.pages.length;
  if (Number.isFinite(first.pageCount)) return first.pageCount;
  return 0;
}

let toolsRegistered = false;
let jobManager = null;
let activeSetupJobId = null;
/** Last submitted stage awaiting user action in the workbench. */
let pendingConfirm = null;
/** Runtime status cache: detectRuntime spawns guard + pip check (seconds);
 * the panel channel times out at 30s and the agent may be racing us. */
let runtimeStatusCache = null;
let runtimeStatusCacheAt = 0;

function getPluginDir() {
  // The plugin host loads main.js from <pluginDir>/main.js. `URL.pathname`
  // keeps percent-encoding, so a repo path with spaces (e.g. "LaboFlow
  // Desktop") would reach every fs call as %20 and never match on disk.
  return dirname(fileURLToPath(import.meta.url));
}

async function resolveDataDir() {
  try {
    const dataPath = await pi.plugin.getDataPath();
    if (dataPath) return dataPath;
  } catch {
    /* host without data dir — fall through to legacy home */
  }
  return null;
}

function runtimeDeps(extra = {}) {
  return {
    pluginDir: getPluginDir(),
    dataDir: globalThis.__pptDataDir,
    // Packaged builds ship an offline wheelhouse via extraResources at
    // <pluginDir>/wheelhouse/<platform>-<arch>; dev checkouts return ""
    // and install online (mirror setting still applies).
    wheelhouseDir: bundledWheelhouseDir(),
    ...extra,
  };
}

function bundledWheelhouseDir() {
  const dir = join(getPluginDir(), "wheelhouse", `${platform()}-${arch()}`);
  return existsSync(dir) ? dir : "";
}

export async function onLoad() {
  if (toolsRegistered) return;
  toolsRegistered = true;

  // Canonical venv home under the plugin data dir (Pi storage isolation).
  globalThis.__pptDataDir = await resolveDataDir();
  const deps = () => runtimeDeps();
  jobManager = createJobManager({ dataDir: globalThis.__pptDataDir, logger: (line) => pi.log?.("info", line) });
  jobManager.recover();

  registerMasterTools();
  registerStageTools();

  await pi.commands.register({
    id: "newPresentation",
    title: "新建 PPT（PPT-Master）/ New presentation",
    keywords: ["ppt", "新建", "演示", "幻灯片", "presentation", "deck"],
    run: async () => {
      // The plugin API cannot prefill the composer or open a docked view,
      // so this palette entry is a signpost to the two real entries: the
      // ppt-master skill ("/" menu) and the dockable PPT workbench view.
      await pi.ui.showToast?.(
        "新建 PPT：在输入框选择技能 /laboflow.ppt-master/ppt-master，或直接说「用 PPT-Master 做一份 PPT：…」。工作台可从面板「+」中打开。",
        "info",
      );
    },
  });

  preProvisionRuntime();
}

/**
 * FR-PPT-17: pre-provision the L2 runtime shortly after load so the first
 * PPT request never waits on an install. Fire-and-forget — a failure only
 * logs; the doctor surfaces the real state when the user asks for PPT.
 * Tests call onLoad() directly with a mocked host, so they can disable this
 * via globalThis.__pptPreProvisionDisabled before import.
 */
const PRE_PROVISION_DELAY_MS = 10_000;

function preProvisionRuntime() {
  if (globalThis.__pptPreProvisionDisabled) return;
  setTimeout(() => {
    void (async () => {
      try {
        const status = await detectRuntime(runtimeDeps());
        if (status.stage === "ready") return;
        const submitted = await startSetupJob();
        pi.log?.(
          "info",
          `[laboflow.ppt-master] runtime pre-provision started: ${submitted.id ?? submitted.jobId} (stage=${status.stage})`,
        );
      } catch (error) {
        pi.log?.("warn", `[laboflow.ppt-master] runtime pre-provision skipped: ${error?.message ?? error}`);
      }
    })();
  }, PRE_PROVISION_DELAY_MS).unref?.();
}

/** Shared setup-job body for the agent tool and the workbench panel. */
async function startSetupJob() {
  if (activeSetupJobId) {
    const existing = jobManager.get(activeSetupJobId);
    if (existing && !["succeeded", "failed", "cancelled", "interrupted"].includes(existing.status)) {
      return { jobId: activeSetupJobId, reused: true };
    }
  }
  const settings = await pi.plugin.getSettings().catch(() => ({}));
  const pipMirror = settings?.pipMirror && settings.pipMirror !== "default" ? settings.pipMirror : undefined;
  const submitted = jobManager.submit({
    kind: "ppt-setup",
    run: async (ctx) => {
      const status = await ensureRuntime({ ...runtimeDeps(), pipMirror, signal: ctx.signal }, ctx.log);
      if (status.stage === "ready") {
        const frozen = await freezeDistributions(runtimeDeps()).catch(() => null);
        const forbidden = findForbiddenDistributions(frozen);
        if (forbidden.length) {
          throw new Error(`AGPL/GPL 黑名单依赖出现在 venv 中：${forbidden.join(", ")}——请删除 venv 重装并检查镜像源`);
        }
        return { stage: status.stage, pythonPath: status.pythonPath, forbidden: [] };
      }
      throw new Error(`${status.stage}: ${status.diag ?? ""}`);
    },
  });
  activeSetupJobId = submitted.id;
  return submitted;
}

// ───────── L2: PPT-Master runtime channel (vendored skill, Phase A) ─────────

/** Every tool goes through reg() so tests can invoke them directly via
 * __registeredTools without a live agent host. The wrapper also surfaces the
 * workbench on EVERY pipeline tool call: the walkthrough showed the model
 * resuming without ever calling ppt_master_status, so keying the auto-open
 * on specific tools left the panel closed for whole sessions. */
const registered = {};
function reg(tool) {
  const wrapped = {
    ...tool,
    execute: async (args) => {
      await openWorkbench();
      return tool.execute(args);
    },
  };
  registered[tool.name] = wrapped;
  void pi.agent.registerTool(wrapped);
}
export const __registeredTools = registered;

/** Plan-b auto-open (design §5.1): the workbench surfaces on the first
 * pipeline tool call. Feature-detected — a host without openView (older
 * LaboFlow, upstream PI-Desktop) logs and continues. */
async function openWorkbench() {
  try {
    await pi.ui?.openView?.({ view: "workbench" });
  } catch (error) {
    pi.log?.("warn", `[laboflow.ppt-master] openView unavailable: ${error?.message ?? error}`);
  }
}

function registerMasterTools() {
  reg({
    name: "ppt_master_status",
    description:
      "Check the PPT-Master (L2 精制引擎, vendored ppt-master) Python runtime and get the paths needed to run it. Takes no parameters. Returns { stage: ready|venv-missing|guard-failed|deps-missing, skillDir, pythonPath, doctor }. ALWAYS call this first before any PPT-Master work: use the returned skillDir/pythonPath for every subsequent script invocation — never guess or search for paths. If not ready, follow doctor (the runtime is pre-provisioned at app startup; call ppt_master_setup to repair). 首次调用会自动打开工作台 (the PPT workbench auto-opens on first call).",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const status = await detectRuntime(runtimeDeps());
      const skillDir = skillRoot(getPluginDir());
      const venvPython = venvPythonPath(resolveRuntimeRoot(runtimeDeps()));
      const payload = {
        ...status,
        skillDir,
        pythonPath: status.pythonPath ?? venvPython,
        hint:
          status.stage === "ready"
            ? "已就绪：按 ppt-master 技能规程用该 pythonPath 执行 ${skillDir}/scripts 下的脚本"
            : "未就绪：按 doctor 提示处理；应用启动时已自动预置运行时（ppt_master_setup 作业），用 ppt_job_status 查看进度",
      };
      return {
        content: `PPT-Master 运行时：${payload.stage}\n${payload.doctor || ""}\n${payload.hint}\n\`\`\`json\n${JSON.stringify({ stage: payload.stage, skillDir: payload.skillDir, pythonPath: payload.pythonPath }, null, 2)}\n\`\`\``,
        details: payload,
      };
    },
  });

  reg({
    name: "ppt_master_setup",
    description:
      "Install the isolated PPT-Master Python runtime (venv + MIT-only requirements + AGPL guard). Runs as a BACKGROUND JOB (takes minutes): returns { jobId } immediately — poll it with ppt_job_status until succeeded, then re-run ppt_master_status. Call only when the user asked to set up the L2 engine or approved the install; if a setup job is already running its jobId is returned instead of starting a second one.",
    risk: "medium",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const submitted = await startSetupJob();
      if (submitted.reused) {
        return {
          content: `已有安装作业进行中：${submitted.jobId}。用 ppt_job_status 轮询即可，无需重复安装。`,
          details: submitted,
        };
      }
      return {
        content: `安装作业已启动：${submitted.id}（后台执行，需数分钟）。请用 ppt_job_status(jobId="${submitted.id}") 轮询；成功后再用 ppt_master_status 确认 ready。`,
        details: submitted,
      };
    },
  });

  reg({
    name: "ppt_job_status",
    description:
      "Poll a PPT plugin background job (e.g. the ppt_master_setup install). Input: { jobId } for one job, or {} for the recent list. Returns status: running | succeeded | failed | cancelled | interrupted, plus the log tail and error when present. Keep polling (suggest waiting ~20s between calls) while a job is running.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id returned by ppt_master_setup" },
      },
    },
    execute: async (args) => {
      const jobId = String(args?.jobId ?? "").trim();
      if (jobId) {
        const job = jobManager.get(jobId);
        if (!job) return { error: `作业不存在：${jobId}` };
        const tail = (job.logTail ?? []).slice(-10);
        return {
          content: `作业 ${job.id}：${job.status}${job.error ? `\n错误：${job.error}` : ""}${
            tail.length ? `\n最近日志：\n- ${tail.join("\n- ")}` : ""
          }`,
          details: job,
        };
      }
      const all = jobManager.list();
      return {
        content: all.length
          ? `最近作业：\n${all.map((job) => `- ${job.id}：${job.status}`).join("\n")}`
          : "尚无后台作业。",
        details: { jobs: all },
      };
    },
  });

  reg({
    name: "ppt_read_doc",
    description:
      "Read the vendored PPT-Master skill corpus (workflows / references / scripts docs / template indexes) that the ppt-master skill routes to. Input: { path } — corpus-relative, e.g. \"workflows/routing.md\", \"references/strategist.md\"; a directory path lists its readable entries. Text only, ≤1MiB per call. Use this instead of Bash cat/Read — the corpus lives outside the workspace sandbox.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Corpus-relative path or directory" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const rootDir = skillRoot(getPluginDir());
      const rel = String(args?.path ?? "");
      const entry = resolveDocEntry(rootDir, rel);
      if (!entry.ok) return { error: entry.reason };
      try {
        if (entry.kind === "dir") {
          const listing = listDocDir(rootDir, entry.absPath, rel);
          return {
            content: `${listing.path}（目录，${listing.entries.length} 项）\n${listing.entries.join("\n")}\n\n${listing.hint}`,
            details: listing,
          };
        }
        const buffer = await readFile(entry.absPath);
        const truncated = buffer.length > MAX_DOC_BYTES;
        const text = buffer.subarray(0, MAX_DOC_BYTES).toString("utf8");
        return {
          content: truncated
            ? `${text}\n\n[截断：文件超过 1MiB，仅显示前 1MiB]`
            : text,
          details: { path: rel, bytes: buffer.length, truncated },
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });
}

// ───────────── Phase B: hard confirmation gates + script whitelist ─────────────

function registerStageTools() {
  reg({
    name: "ppt_script",
    description:
      "Run a whitelisted vendored PPT-Master script with the isolated venv (argparse-faithful args). Whitelist: project_manager(init/import-sources/validate) | source_to_md | text_measure(calibrate) | quality_checker(early/final gates) | finalize_svg | total_md_split | svg_to_pptx | image_search | pptx_template_import. finalize/total_md_split/svg_to_pptx are EXPORT-GATED: they refuse unless the user confirmed Stage-2 in the PPT workbench (or explicitly waived). Runs sync up to 60s, then continues as a background job — poll ppt_job_status. PDF routes are disabled (AGPL).",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        script: { type: "string", enum: Object.keys(PPT_SCRIPTS), description: "Whitelisted script name" },
        args: { type: "object", description: "Per-script arguments (see each script's schema in the tool description of ppt_script_help)" },
      },
      required: ["script", "args"],
    },
    execute: async (input) => {
      // FR-PPT-13: the workbench toggle is the DEFAULT for the native
      // charts/tables flag; an explicit agent arg still wins.
      let scriptArgs = input?.args;
      if (
        input?.script === "svg_to_pptx" &&
        scriptArgs?.nativeChartsAndTables === undefined &&
        typeof scriptArgs?.projectPath === "string" &&
        scriptArgs.projectPath.trim()
      ) {
        scriptArgs = {
          ...scriptArgs,
          nativeChartsAndTables: getExportPrefs(scriptArgs.projectPath.trim()).nativeChartsAndTables === true,
        };
      }
      const plan = planScript({
        pluginDir: getPluginDir(),
        script: input?.script,
        args: scriptArgs,
        exportGate: (projectDir) => assertExportAllowed(projectDir),
      });
      if (!plan.ok) {
        return { error: plan.error, code: plan.code, ...(plan.gate ? { gate: true } : {}) };
      }
      const runOnce = (timeoutMs, signal) =>
        execRunner(venvPythonPath(resolveRuntimeRoot(runtimeDeps())), [plan.scriptPath, ...plan.argv], {
          cwd: plan.cwd,
          timeoutMs,
          signal,
          env: { PPT_MASTER_DISABLE_PDF: "1", PYTHONIOENCODING: "utf-8" },
        });
      try {
        let result = await runOnce(plan.syncBudgetMs);
        if (result.timedOut) {
          // Budget exhausted → keep the same command running as a job.
          const submitted = jobManager.submit({
            kind: `ppt-script-${input.script}`,
            run: async (ctx) => {
              const full = await runOnce(15 * 60_000, ctx.signal);
              if (full.code !== 0) throw new Error(`退出码 ${full.code}：${full.stderr || full.stdout}`.slice(-1500));
              return { stdout: full.stdout.slice(-4000) };
            },
          });
          return {
            content: `${plan.script} 需要 longer than 60s，已转入后台作业 ${submitted.id}。用 ppt_job_status(jobId="${submitted.id}") 轮询。`,
            details: { jobId: submitted.id, script: input.script, async: true },
          };
        }
        if (result.code !== 0) {
          return { error: `${plan.script} 退出码 ${result.code}：${result.stderr || result.stdout}`.slice(-1500) };
        }
        // 遗留 B: a started live-preview daemon is watched for its Exit-preview
        // lock release (workbench status line + Stage 2 annotation-apply
        // resume). Shutdown calls are the user asking to stop — nothing to watch.
        if (input?.script === "svg_editor" && plan.argv[0] === "--live") {
          const daemonDir = safeToken(
            scriptArgs?.projectDir ?? scriptArgs?.project_dir ?? scriptArgs?.projectPath ?? "",
          );
          if (daemonDir) {
            try {
              const ctxSession = pi.session ? await pi.session.getLlmContext?.() : null;
              if (ctxSession?.sessionId) sessionProjects.set(ctxSession.sessionId, daemonDir);
            } catch { /* binding is best-effort */ }
            startPreviewWatch(daemonDir);
          }
        }
        return {
          content: `${plan.summary}\n\n${(result.stdout || result.stderr || "ok").slice(-4000)}`,
          details: { script: input.script, argv: plan.argv, exit: 0 },
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });

  reg({
    name: "ppt_stage_submit",
    description:
      "两阶段确认的唯一确认通道（勿用 asktool/对话确认） — the ONLY confirmation channel. Submit your design recommendations for user confirmation (PPT-Master Stage-1 沟通契约+模板选择, or Stage-2 三个设计方向). The pending decision renders in the PPT workbench hero confirmation zone — the user confirms there; no popup opens. Then STOP and wait: silence confirms nothing. Input: { projectDir, stage: stage1|stage2, recommendations }. After submitting, tell the user what to look at and poll ppt_stage_status; do NOT proceed past a ⛔ BLOCKING gate until status returns confirmed/waived.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        projectDir: { type: "string", description: "PPT-Master 项目目录（绝对路径）" },
        stage: { type: "string", enum: STAGES },
        recommendations: { type: "object", description: "上游格式的推荐内容（stage2 需含 directions 数组）" },
      },
      required: ["projectDir", "stage", "recommendations"],
    },
    execute: async (args) => {
      const projectDir = String(args?.projectDir ?? "").trim();
      const stage = String(args?.stage ?? "").trim();
      if (!projectDir) return { error: "projectDir is required" };
      // FR-PPT-16: cost estimate rides every submission and is persisted in
      // the pipeline state; stage-2 refuses when the configured deck budget
      // is exceeded (settings → budgetTokens).
      const settings = await pi.plugin.getSettings().catch(() => ({}));
      const pageCount = countStagePages(args?.recommendations);
      const estimate = budgetVerdict(pageCount, settings?.budgetTokens);
      if (stage === "stage2" && !estimate.ok) {
        return {
          error: `预估消耗 ${estimate.estimate} tokens，超过预算上限 ${estimate.budget}（可在插件设置调整 budgetTokens）`,
          code: estimate.code,
          estimate: estimate.estimate,
          budget: estimate.budget,
        };
      }
      const verdict = submitStage(projectDir, stage, args?.recommendations, undefined, estimate.estimate);
      if (verdict.error) return { error: verdict.error };
      try {
        const ctxSession = pi.session ? await pi.session.getLlmContext?.() : null;
        if (ctxSession?.sessionId) sessionProjects.set(ctxSession.sessionId, projectDir);
      } catch { /* binding is best-effort */ }
      pendingConfirm = { projectDir, stage, submittedAt: verdict.state.stages[stage]?.submittedAt ?? null };
      // Plan-b: surface the workbench with the fresh pending decision — the
      // user should never hunt for the panel a confirmation was just sent to.
      await openWorkbench();
      // The docked workbench polls for this pending decision and renders it in
      // the hero confirmation zone — the plugin's only confirmation surface. Keep
      // a native notification so the user knows a decision is waiting even
      // when the workbench tab is closed.
      try {
        pi.ui.showNativeNotification?.({
          title: "PPT 设计方案待确认",
          body: "打开右侧 PPT 工作台，在「设计确认」区确认",
        });
      } catch {
        /* notifications optional */
      }
      return {
        content: `已提交 ${stage} 设计方案：用户将在右侧 PPT 工作台的「设计确认」英雄区操作（工作台已自动打开）。**保持本回合存活**：立即开始轮询 ppt_stage_status(projectDir, stage)（约每 20 秒一次），直到返回 confirmed/waived——你不需要在对话里等待用户回复，也**不要结束回合**。沉默不构成确认；等待期间不要推进任何 ⛔ BLOCKING 之后的步骤。`,
        details: { statePath: join(projectDir, "laboflow", "pipeline-state.json"), estimate: estimate.estimate },
      };
    },
  });

  reg({
    name: "ppt_stage_status",
    description:
      "Check the user's decision on a submitted PPT-Master stage. Input: { projectDir, stage? } — omit stage for the whole pipeline state. Returns pending/submitted (keep waiting) or confirmed (with result.json, READ-ONCE: later calls return a cached summary) or waived (quick mode).",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        projectDir: { type: "string", description: "PPT-Master 项目目录（绝对路径）" },
        stage: { type: "string", enum: STAGES },
      },
      required: ["projectDir"],
    },
    execute: async (args) => {
      const projectDir = String(args?.projectDir ?? "").trim();
      if (!projectDir) return { error: "projectDir is required" };
      const stage = args?.stage ? String(args.stage) : null;
      if (stage) {
        const verdict = readStageResult(projectDir, stage);
        if (verdict.error) return { error: verdict.error };
        // F-6 keep-alive: a status poll that OBSERVES the transition to
        // confirmed is the exact moment the turn needs to continue — fire the
        // resume here too (deduped per decision inside the helper).
        if (verdict.status === "confirmed") void resumeSessionAfterConfirm(stage, false);
        return {
          content: `${stage}：${verdict.status}${verdict.warning ? `\n${verdict.warning}` : ""}${verdict.message ? `\n${verdict.message}` : ""}${verdict.status === "confirmed" ? "\n用户已确认：立即继续执行下一步骤，不要结束回合、不要等待用户。" : ""}`,
          details: verdict,
        };
      }
      const { state, created, corrupted } = loadState(projectDir);
      return {
        content: `管线状态：${JSON.stringify(state.stages)}${corrupted ? "\n（状态文件曾损坏，已重置为 pending）" : ""}`,
        details: { state, created, corrupted },
      };
    },
  });
}

// ───────────────────────── Panel bridge (workbench) ─────────────────────────


/**
 * F-2 structural fix: after a workbench confirmation the agent turn may have
 * already ended (the model's polling compliance is best-effort). Ask the host
 * to resume the active session with an explicit continuation instruction.
 * Feature-detected: hosts without session.continueFromPlugin (or without the
 * permission granted) are skipped silently — the wording-level fallback in
 * the stage tools still applies there.
 */
const sessionProjects = new Map();
/** Session→project binding (F-5 follow-up): the selector follows the
 * project the ACTIVE session is actually working in, instead of guessing by
 * recency. Recorded on stage submission; best-effort, in-memory. */
let lastResumeKey = null;
async function resumeSessionAfterConfirm(stage, waive) {
  const dedupe = `${stage}:${waive ? "w" : "c"}`;
  if (lastResumeKey === dedupe) return; // one resume per decision
  lastResumeKey = dedupe;
  try {
    const ctx = await pi.session?.getLlmContext?.();
    const sessionId = ctx?.sessionId;
    if (!sessionId) return;
    await pi.session?.continueFromPlugin?.({
      sessionId,
      text: waive
        ? `用户已在工作台豁免 ${stage}（快速模式）。继续管线：按 Quick profile 推进，不要再次征询确认。`
        : `用户已在工作台确认 ${stage}。继续管线下一步（先 ppt_stage_status 核对结果再推进），不要停顿等待用户。`,
      reason: waive ? "stage-waived" : "stage-confirmed",
    });
  } catch (error) {
    pi.log?.("warn", `[laboflow.ppt-master] session continue unavailable: ${error?.message ?? error}`);
  }
}

// ───────────── Live-preview exit watching (Exit-preview guidance) ─────────────

/**
 * 遗留 B: when the user clicks Exit preview in the SVG editor, the flask
 * server releases live_preview/lock.json and dies — the agent never learns
 * the preview ended, so annotation application waits for a manual prompt.
 * While a preview this plugin started is up, a 3s poll watches for that
 * lock release; when it happens the workbench status line is fed via
 * ppt.getPreviewStatus and the live-preview Stage 2 "apply annotations"
 * continuation is injected through session.continueFromPlugin (deduped per
 * preview session, F-2 channel — same as the confirm resumes).
 */
const livePreviews = new Map(); // projectDir -> { startedAtMs, sawLock, closedAtMs, annotationsSaved, timer }
let lastPreviewResumeKey = null;

const PREVIEW_POLL_MS = 3_000;

function startPreviewWatch(projectDir) {
  const previous = livePreviews.get(projectDir);
  if (previous?.timer) clearInterval(previous.timer);
  const entry = {
    startedAtMs: Date.now(),
    sawLock: false,
    closedAtMs: 0,
    annotationsSaved: false,
    timer: null,
  };
  livePreviews.set(projectDir, entry);
  entry.timer = setInterval(() => pollPreviewLock(projectDir), PREVIEW_POLL_MS);
  pollPreviewLock(projectDir);
}

function stopPreviewWatch(projectDir) {
  const entry = livePreviews.get(projectDir);
  if (entry?.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

function pollPreviewLock(projectDir) {
  const entry = livePreviews.get(projectDir);
  if (!entry) return;
  if (Date.now() - entry.startedAtMs > PREVIEW_WATCH_MAX_MS) {
    stopPreviewWatch(projectDir);
    return;
  }
  try {
    if (existsSync(lockFilePath(projectDir))) {
      entry.sawLock = true;
      return;
    }
    // No lock yet only means the daemon is still booting (or died at boot);
    // the exit event is the TRANSITION from lock-present to lock-absent.
    if (!entry.sawLock) return;
    entry.closedAtMs = Date.now();
    stopPreviewWatch(projectDir);
    entry.annotationsSaved = readAnnotationRecordCount(projectDir) > 0;
    void resumeSessionAfterPreviewExit(projectDir, entry);
  } catch {
    /* transient fs errors: the next poll retries */
  }
}

function readAnnotationRecordCount(projectDir) {
  try {
    return countAnnotationRecords(readFileSync(annotationsLogPath(projectDir), "utf8"));
  } catch {
    return 0;
  }
}

function boundSessionForProject(projectDir) {
  for (const [sessionId, dir] of sessionProjects) {
    if (dir === projectDir) return sessionId;
  }
  return null;
}

async function resumeSessionAfterPreviewExit(projectDir, entry) {
  const dedupe = `preview-exit:${projectDir}:${entry.startedAtMs}`;
  if (lastPreviewResumeKey === dedupe) return; // one resume per preview session
  lastPreviewResumeKey = dedupe;
  try {
    const ctx = await pi.session?.getLlmContext?.();
    const sessionId = boundSessionForProject(projectDir) ?? ctx?.sessionId;
    if (!sessionId) return;
    const head = entry.annotationsSaved
      ? `用户已在预览页点击 Exit preview，实时预览服务已关闭，批注已保存到 live_preview/annotations.jsonl。`
      : `用户已在预览页点击 Exit preview，实时预览服务已关闭（未检测到已保存的批注）。`;
    await pi.session?.continueFromPlugin?.({
      sessionId,
      text: `${head}请按 live-preview Stage 2 规程处理收尾，不要等待用户：1) 用 Bash 运行 check_annotations.py（项目目录 ${projectDir}）列出待应用批注；2) 逐条把批注落到 svg_output 对应元素（按批注文字修改元素，移除 data-edit-target / data-edit-annotation 标记，并追加 annotation_applied 记录到 live_preview/annotations.jsonl）；3) 有改动时用 ppt_script 依次重跑质检与导出（quality_checker final → finalize_svg → svg_to_pptx）；4) 完成后告知用户结果；若第 1 步报告没有待应用批注，直接告知用户预览已关闭即可结束。`,
      reason: "preview-exit-annotations",
    });
  } catch (error) {
    pi.log?.("warn", `[laboflow.ppt-master] preview-exit continue unavailable: ${error?.message ?? error}`);
  }
}

async function detectRuntimeCached(maxAgeMs = 5_000) {
  const now = Date.now();
  if (runtimeStatusCache && now - runtimeStatusCacheAt < maxAgeMs) return runtimeStatusCache;
  runtimeStatusCache = await detectRuntime(runtimeDeps());
  runtimeStatusCacheAt = now;
  return runtimeStatusCache;
}

/**
 * The plugin process can reload between submit and user action (hot reload,
 * crash): pendingConfirm lives in memory only. Recover the waiting stage from
 * the pipeline state files on disk so the card never shows "nothing pending"
 * while a project actually awaits confirmation.
 *
 * Recovering is bounded in time: an abandoned flow leaves its "submitted"
 * status on disk forever, and surfacing it on every workbench open turned the
 * confirmation section into a permanent fixture. Only submissions from the
 * last PENDING_RECOVERY_WINDOW_MS recover automatically; older projects stay
 * reachable through the pipeline input, and a live ppt_stage_submit always
 * shows regardless of age.
 */
const PENDING_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

async function recoverPendingFromDisk() {
  if (pendingConfirm) return pendingConfirm;
  try {
    const workspace = await pi.workspace.get();
    const projectsDir = join(String(workspace?.path ?? ""), "projects");
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    let best = null;
    for (const entry of readdirSync(projectsDir, { withFileTypes: true }) ?? []) {
      if (!entry.isDirectory()) continue;
      const stateFile = join(projectsDir, entry.name, "laboflow", "pipeline-state.json");
      let state;
      try {
        state = JSON.parse(readFileSync(stateFile, "utf8"));
      } catch {
        continue;
      }
      for (const stage of ["stage1", "stage2"]) {
        if (state?.stages?.[stage]?.status === "submitted") {
          const submittedAt = Date.parse(state.stages[stage]?.submittedAt ?? "");
          if (!Number.isFinite(submittedAt) || Date.now() - submittedAt > PENDING_RECOVERY_WINDOW_MS) {
            continue;
          }
          const mtime = statSync(stateFile).mtimeMs;
          if (!best || mtime > best.mtime) {
            best = { projectDir: join(projectsDir, entry.name), stage, mtime };
          }
        }
      }
    }
    if (best) {
      pendingConfirm = { projectDir: best.projectDir, stage: best.stage, submittedAt: null, recovered: true };
    }
  } catch {
    /* no workspace / no projects dir — nothing to recover */
  }
  return pendingConfirm;
}

function projectListings(projectDir) {
  const safeList = (dir, exts) => {
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => exts.some((ext) => name.toLowerCase().endsWith(ext)))
        .map((name) => {
          const full = join(dir, name);
          let bytes = 0;
          try {
            bytes = statSync(full).size;
          } catch {
            /* vanished */
          }
          return { name, bytes };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  };
  return {
    svgPages: safeList(join(projectDir, "svg_output"), [".svg"]),
    svgFinal: safeList(join(projectDir, "svg_final"), [".svg"]),
    exports: safeList(join(projectDir, "exports"), [".pptx"]),
    backups: (() => {
      try {
        return readdirSync(join(projectDir, "backup"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name }))
          .sort((a, b) => b.name.localeCompare(a.name));
      } catch {
        return [];
      }
    })(),
  };
}

/**
 * Workbench-v2 T9: cheap file-presence facts for the pipeline timeline — the
 * renderer cannot stat files, so the flags ride the ppt.getState response.
 * Paths are the vendored pipeline's canonical outputs (generate-pptx.md):
 * design_spec.md + spec_lock.md at the project root, the QC gate reports and
 * the text-measure calibration under validation/. The qualityReport flag
 * counts only the final-gate report (`svg_quality_report*.json`), not the
 * early/first-page/page variants. Anything missing degrades to false — a
 * fact absence must never break the panel response.
 */
function projectFileFacts(projectDir) {
  const exists = (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  };
  const validationDir = join(projectDir, "validation");
  let qualityReport = false;
  try {
    qualityReport = readdirSync(validationDir).some((name) => /^svg_quality_report.*\.json$/i.test(name));
  } catch {
    qualityReport = false; // no validation dir yet
  }
  return {
    designSpec: exists(join(projectDir, "design_spec.md")),
    specLock: exists(join(projectDir, "spec_lock.md")),
    qualityReport,
    calibration: exists(join(validationDir, "text_calibration.json")),
  };
}

/**
 * Workbench-v2 T10: whitelist reads for the pipeline's validation artifacts.
 * The renderer cannot read files itself, and a generic read channel would
 * expose the whole disk to the panel — so this accepts ONLY the three
 * canonical artifacts written by the vendored pipeline (svg_quality/cli.py
 * stage map + text measure calibrate): the final and early QC reports and
 * the text-measure calibration (T11 renders it). Names are basename
 * whitelisted and joined under <projectDir>/validation, so no payload field
 * ever reaches the filesystem unvalidated. Parsed JSON, capped at 1MiB per
 * file — a larger artifact is refused with an explicit error instead of
 * serving JSON that would truncate mid-token.
 */
const MAX_REPORT_BYTES = 1024 * 1024;
const REPORT_FILES = {
  "svg_quality_report.json": "final",
  "svg_quality_early_report.json": "early",
  "text_calibration.json": "calibration",
};

async function readValidationJson(projectDir, file) {
  let fh;
  try {
    fh = await open(join(projectDir, "validation", file), "r");
  } catch (error) {
    if (error?.code === "ENOENT") return { code: "absent" };
    return { code: "io", error: `读取失败：validation/${file}（${error?.message ?? error}）` };
  }
  // T11 (T10 ledger fold): stat-before-read — fstatSync sizes the OPEN fd
  // before any byte is read, so a pathologically large artifact is refused
  // instead of being slurped into memory first (the old read-then-measure
  // order charged the full read before rejecting).
  try {
    const size = fstatSync(fh.fd).size;
    if (size > MAX_REPORT_BYTES) {
      return {
        code: "too-large",
        error: `validation/${file} 超过 1MiB 上限（${Math.ceil(size / 1024)} KB），已拒绝读取`,
      };
    }
    const buffer = await fh.readFile();
    try {
      return { code: "ok", json: JSON.parse(buffer.toString("utf8")) };
    } catch {
      return { code: "parse", error: `validation/${file} 不是有效的 JSON` };
    }
  } catch (error) {
    return { code: "io", error: `读取失败：validation/${file}（${error?.message ?? error}）` };
  } finally {
    try {
      await fh.close();
    } catch {
      /* fd already closed or never usable — nothing to recover */
    }
  }
}

/**
 * Workbench-v2 T1: newest-first summary of every directory under
 * <workspace>/projects for the project selector. Reuses the shared helpers:
 * stage statuses via loadState (which quarantines a corrupt state file — its
 * standard recovery semantics), counts via projectListings, and a bounded
 * recursive mtime walk for last activity. Any missing piece (no workspace,
 * no projects dir, unreadable project) degrades to "skip / empty", never to
 * a thrown error — the selector must always render.
 */
const MAX_LISTED_PROJECTS = 20;
/** Project trees are small (state + confirm_ui + pages + exports); the cap
 * only exists so a pathological tree cannot hang the workbench open. */
const LAST_ACTIVITY_MAX_FILES = 2000;

function lastActivityMs(projectDir) {
  let newest = 0;
  let seen = 0;
  const stack = [projectDir];
  while (stack.length > 0 && seen < LAST_ACTIVITY_MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= LAST_ACTIVITY_MAX_FILES) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return newest;
}

async function listWorkspaceProjects() {
  let projectsDir;
  try {
    const workspace = await pi.workspace.get();
    // Falsy workspace (T1 review minor): resolve nothing rather than joining a
    // cwd-relative "projects" onto an empty path.
    if (!workspace) return [];
    projectsDir = join(String(workspace?.path ?? ""), "projects");
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return []; // no workspace or no projects dir yet
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(projectsDir, entry.name);
    try {
      const { state } = loadState(projectDir);
      const listings = projectListings(projectDir);
      projects.push({
        name: entry.name,
        projectDir,
        s1: state?.stages?.stage1?.status ?? "pending",
        s2: state?.stages?.stage2?.status ?? "pending",
        svgPages: listings.svgPages.length,
        svgFinal: listings.svgFinal.length,
        exports: listings.exports.length,
        lastActivityMs: lastActivityMs(projectDir),
      });
    } catch {
      /* unreadable project: skip it rather than breaking the selector */
    }
  }
  projects.sort((a, b) => b.lastActivityMs - a.lastActivityMs || a.name.localeCompare(b.name));
  return projects.slice(0, MAX_LISTED_PROJECTS);
}

export async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "ppt.listProjects":
      let activeSessionId = null;
      try {
        activeSessionId = (await pi.session?.getLlmContext?.())?.sessionId ?? null;
      } catch { /* context optional */ }
      const projects = await listWorkspaceProjects();
      const bound = activeSessionId ? sessionProjects.get(activeSessionId) : null;
      if (bound) {
        for (const project of projects) {
          if (project.projectDir === bound) project.boundToActiveSession = true;
        }
      }
      return { projects, boundProjectDir: bound };
    case "ppt.getBootstrap": {
      const [runtime, pending] = await Promise.all([detectRuntimeCached(), recoverPendingFromDisk()]);
      return { pending, runtime, projects: pending ? [pending.projectDir] : [] };
    }
    case "ppt.getState": {
      const projectDir = String(payload.projectDir ?? "");
      if (!projectDir) return { error: "projectDir required" };
      const { state, corrupted } = loadState(projectDir);
      const confirmDir = join(projectDir, "confirm_ui");
      const readJson = async (file) => {
        try {
          return JSON.parse(await readFile(join(confirmDir, file), "utf8"));
        } catch {
          return null;
        }
      };
      return {
        state,
        corrupted,
        recommendations: {
          stage1: await readJson("recommendations.stage1.json"),
          stage2: await readJson("recommendations.stage2.json"),
        },
        listings: projectListings(projectDir),
        // Workbench-v2 T9: file-presence facts beside the listings — the
        // timeline's spec/QC nodes key off these flags.
        files: projectFileFacts(projectDir),
      };
    }
    case "ppt.confirmStage": {
      const projectDir = String(payload.projectDir ?? "");
      const stage = String(payload.stage ?? "");
      const waive = payload.waive === true;
      // Workbench-v2 T4: user-edited fields ride along; the state machine
      // whitelists (STAGE_OVERRIDE_FIELDS) and merges them into result.json.
      // Workbench-v2 T8: the stage-1 template root selection rides its own
      // channel field — it belongs in template_selection.json, never in the
      // overrides/result.json (upstream rule).
      const verdict = confirmStage(projectDir, stage, {
        waive,
        waiveReason: payload.waiveReason,
        overrides: payload.overrides,
        templateSelection: payload.templateSelection,
      });
      if (verdict.error) return { error: verdict.error };
      if (pendingConfirm?.projectDir === projectDir && pendingConfirm?.stage === stage) {
        pendingConfirm = null;
      }
      // F-2: the user just decided in this plugin's own surface — resume the
      // agent turn so the pipeline continues without a manual nudge. The
      // message is origin-tagged and visible in the transcript.
      void resumeSessionAfterConfirm(stage, waive);
      try {
        pi.ui.showToast?.(`已${waive ? "豁免" : "确认"} ${stage}`, "success");
      } catch {
        /* toast optional */
      }
      return { ok: true, state: verdict.state };
    }
    case "ppt.runtimeStatus":
      return { runtime: await detectRuntimeCached() };
    case "ppt.setup": {
      const submitted = await startSetupJob();
      return { jobId: submitted.id ?? submitted.jobId, reused: !!submitted.reused };
    }
    case "ppt.jobStatus":
      return { jobs: jobManager.list() };
    case "ppt.readSvg": {
      const path = String(payload.path ?? "");
      if (!path.toLowerCase().endsWith(".svg")) return { error: "仅支持 .svg" };
      try {
        const text = await readFile(path, "utf8");
        return { svg: text.slice(0, 4 * 1024 * 1024) };
      } catch (error) {
        return { error: error?.message ?? String(error) };
      }
    }
    // Workbench-v2 T10: {projectDir} reads all three whitelisted artifacts
    // (absent files are simply absent keys — the panel hides an empty
    // section); {projectDir, name} reads exactly one, and any name outside
    // the whitelist (traversal, other json) is rejected with an error.
    // Unreadable/too-large artifacts surface as an errors map, never as a
    // silent skip or a thrown bridge failure.
    case "ppt.readReport": {
      const projectDir = String(payload.projectDir ?? "");
      if (!projectDir) return { error: "projectDir required" };
      const name = payload.name == null ? "" : String(payload.name);
      if (name) {
        // T11 (T10 ledger fold): own-property lookup only — a name like
        // "toString" must miss via the prototype chain and get the whitelist
        // error, not resolve to an inherited function.
        const key = Object.hasOwn(REPORT_FILES, name) ? REPORT_FILES[name] : null;
        if (!key) {
          return { error: `仅允许读取 validation/ 下的 ${Object.keys(REPORT_FILES).join(" / ")}` };
        }
        const result = await readValidationJson(projectDir, name);
        if (result.code === "absent") return { error: `validation/${name} 不存在` };
        if (result.code !== "ok") return { error: result.error };
        return { reports: { [key]: result.json } };
      }
      const reports = {};
      const errors = {};
      for (const [file, key] of Object.entries(REPORT_FILES)) {
        const result = await readValidationJson(projectDir, file);
        if (result.code === "ok") reports[key] = result.json;
        else if (result.code !== "absent") errors[key] = result.error;
      }
      return { reports, ...(Object.keys(errors).length ? { errors } : {}) };
    }
    case "ppt.getExportPrefs": {
      const projectDir = String(payload.projectDir ?? "");
      if (!projectDir) return { error: "projectDir required" };
      return { prefs: getExportPrefs(projectDir) };
    }
    case "ppt.setExportPrefs": {
      const projectDir = String(payload.projectDir ?? "");
      if (!projectDir) return { error: "projectDir required" };
      return setExportPrefs(projectDir, payload.prefs);
    }
    case "ppt.deletePage": {
      const projectDir = String(payload.projectDir ?? "");
      const dir = String(payload.dir ?? "");
      const name = String(payload.name ?? "");
      if (!projectDir) return { error: "projectDir required" };
      const result = deletePage(projectDir, dir, name);
      return result.ok ? { ok: true, listings: projectListings(projectDir) } : result;
    }
    case "ppt.movePage": {
      const projectDir = String(payload.projectDir ?? "");
      const dir = String(payload.dir ?? "");
      const name = String(payload.name ?? "");
      const direction = payload.direction === "next" ? "next" : "prev";
      if (!projectDir) return { error: "projectDir required" };
      const result = movePage(projectDir, dir, name, direction);
      return result.ok ? { ok: true, swappedWith: result.swappedWith, listings: projectListings(projectDir) } : result;
    }
    case "ppt.getPreviewStatus": {
      // 遗留 B: the workbench status line polls this with the 2s hero poll —
      // cheap Map lookup, no fs I/O (the watcher already did the reading).
      const projectDir = String(payload.projectDir ?? "");
      if (!projectDir) return { error: "projectDir required" };
      const entry = livePreviews.get(projectDir) ?? null;
      return { preview: previewStatusFor(entry, Date.now()), closedAtMs: entry?.closedAtMs ?? null };
    }
    case "ppt.resumePipeline": {
      // V5-T5: the planning phase has no gate for the model to poll, so the
      // workbench's draw node carries a one-click resume. Route it through
      // the same session-continue injection the confirm path uses.
      const projectDir2 = String(payload.projectDir ?? "");
      if (!projectDir2) return { error: "projectDir required" };
      void resumeSessionAfterConfirm("planning", false);
      return { ok: true };
    }
    case "ppt.openPath": {
      const path = String(payload.path ?? "");
      if (!existsSync(path)) return { error: "路径不存在" };
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawnExec(`${command} ${JSON.stringify(path)}`, () => {});
      return { ok: true };
    }
    default:
      return { error: `unknown channel: ${channel}` };
  }
}

export function onUnload() {
  toolsRegistered = false;
  jobManager = null;
  activeSetupJobId = null;
  pendingConfirm = null;
  for (const entry of livePreviews.values()) {
    if (entry.timer) clearInterval(entry.timer);
  }
  livePreviews.clear();
}
