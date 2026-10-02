/**
 * Slides — bundled first-party plugin (module 06).
 *
 * L1 (fast engine): `slides_plan` normalizes/validates the outline the AGENT
 * drafted from the conversation, `slides_export` writes the confirmed outline
 * as an editable .pptx via the vendored pptxgenjs. All heavy logic lives in
 * ./lib/slides.js so it stays testable without a plugin host.
 *
 * L2 (PPT-Master, vendored skill — DEVPLAN Phase A): the skill corpus guides
 * the agent (skills/ppt-master.md thin shell + upstream body); these tools
 * expose only what the agent cannot do itself:
 *   - ppt_master_status: five-state runtime inspection + the {skillDir,
 *     pythonPath} pair the skill preamble requires before any Bash call
 *   - ppt_master_setup: venv bootstrap as a background job (uv preferred,
 *     AGPL-guarded MIT-only subset) — setup exceeds the 110s tool budget
 *   - ppt_job_status: poll background jobs
 *   - ppt_read_doc: read-only whitelist bridge into the vendored corpus
 *     (the agent's Read sandbox cannot reach the app bundle)
 * Phase B adds ppt_script (whitelisted script runner with hard confirm
 * gates) and the stage confirmation tools; the old ppt_quality/finalize/
 * export wrappers are gone — their CLI arg contracts were wrong and
 * ppt_script replaces them with argparse-faithful schemas.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { exec as spawnExec } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { exportDeckToBuffer, normalizeOutline, sanitizeFileName } from "./lib/slides.js";
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
  loadState,
  readStageResult,
  STAGES,
  submitStage,
} from "./lib/ppt-state.js";
import { budgetVerdict } from "./lib/ppt-estimate.js";
import { PPT_SCRIPTS, planScript } from "./lib/ppt-script.js";

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
/** Last submitted stage awaiting user action in the confirm card. */
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
  return { pluginDir: getPluginDir(), dataDir: globalThis.__pptDataDir, ...extra };
}

async function resolveOutputPath(fileName) {
  let root = "";
  try {
    const workspace = await pi.workspace.get();
    root = String(workspace?.path ?? "");
  } catch {
    root = "";
  }
  const settings = await pi.plugin.getSettings().catch(() => ({}));
  const folder = String(settings?.outputDir ?? "slides").replace(/^\/+|\/+$/g, "") || "slides";
  return root
    ? join(root, folder, fileName)
    : join(process.cwd(), folder, fileName);
}

export async function onLoad() {
  if (toolsRegistered) return;
  toolsRegistered = true;

  // Canonical venv home under the plugin data dir (Pi storage isolation).
  globalThis.__pptDataDir = await resolveDataDir();
  const deps = () => runtimeDeps();
  jobManager = createJobManager({ dataDir: globalThis.__pptDataDir, logger: (line) => pi.log?.("info", line) });
  jobManager.recover();

  registerL1Tools();
  registerMasterTools();
  registerStageTools();

  await pi.commands.register({
    id: "openConfirmCard",
    title: "Slides: 打开 PPT 确认卡 / Open PPT confirm card",
    keywords: ["ppt", "确认", "confirm", "slides", "设计", "pipeline"],
    run: async () => {
      await pi.ui.openPanel({ title: "PPT 确认卡" });
    },
  });
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

function registerL1Tools() {
  void pi.agent.registerTool({
    name: "slides_plan",
    description:
      "Normalize and validate a slide-deck outline you drafted from the conversation. Input: { topic, outline: { deckTitle, pages: [{ layout, title, subtitle?, bullets?, data?, columns?, matrix?, milestones?, quote?, attribution?, speakerNotes? }] } }. Returns the canonical outline — show it to the user for review BEFORE calling slides_export.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Deck subject and core message" },
        outline: { type: "object", description: "Your drafted outline: { deckTitle, pages: [...] }" },
      },
      required: ["topic", "outline"],
    },
    execute: async (args) => {
      const topic = String(args?.topic ?? "").trim();
      if (!topic) return { error: "topic is required" };
      if (!args?.outline || typeof args.outline !== "object") {
        return { error: "outline object is required: { deckTitle, pages }" };
      }
      try {
        const normalized = normalizeOutline({
          ...args.outline,
          deckTitle: args.outline.deckTitle ?? topic,
        });
        const warnings = [];
        normalized.pages.forEach((page, index) => {
          if (page.layout === "bullets" && !(page.bullets ?? []).length) {
            warnings.push(`第 ${index + 1} 页（${page.title}）为 bullets 版式但没有要点`);
          }
          if (page.title && page.title.length <= 8 && !["title", "end", "quote"].includes(page.layout)) {
            warnings.push(`第 ${index + 1} 页标题「${page.title}」偏短语——行动标题应为完整判断句`);
          }
        });
        return {
          content: [
            `大纲已规范化（${normalized.pages.length} 页）。请向用户逐页确认或按修改意见调整，确认后调用 slides_export 导出。`,
            warnings.length ? `\n质量提示：\n- ${warnings.join("\n- ")}` : "",
            `\n\n${JSON.stringify(normalized, null, 2)}`,
          ].join(""),
          details: { outline: normalized, warnings },
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });

  void pi.agent.registerTool({
    name: "slides_export",
    description:
      "Export a confirmed outline as an editable .pptx file (PowerPoint/WPS/LibreOffice compatible; every element is a native text box or table). Input: { deckTitle, pages: [...], theme? }. Returns the written file path. Call this only after the user confirmed the outline.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        deckTitle: { type: "string" },
        fileName: { type: "string" },
        theme: {
          type: "object",
          properties: {
            accent: { type: "string" },
            font: { type: "string" },
          },
        },
        pages: { type: "array", items: { type: "object", properties: { layout: { type: "string" }, title: { type: "string" } } } },
      },
      required: ["deckTitle", "pages"],
    },
    execute: async (args) => {
      const deckTitle = String(args?.deckTitle ?? "").trim();
      if (!deckTitle) return { error: "deckTitle is required" };
      if (!Array.isArray(args?.pages) || args.pages.length === 0) {
        return { error: "pages must be a non-empty array" };
      }
      try {
        const settings = await pi.plugin.getSettings().catch(() => ({}));
        const theme = {
          accent: args?.theme?.accent ?? settings?.accentColor ?? "1F4E79",
          font: args?.theme?.font,
        };
        const { normalized, buffer } = await exportDeckToBuffer(
          { deckTitle, pages: args.pages },
          theme,
        );
        const fileName = `${sanitizeFileName(args?.fileName ?? normalized.deckTitle)}.pptx`;
        const outputPath = await resolveOutputPath(fileName);
        await mkdir(join(outputPath, ".."), { recursive: true });
        await writeFile(outputPath, buffer);
        return {
          content: `已导出可编辑 PPTX（${normalized.pages.length} 页）：${outputPath}\n可在 PowerPoint / WPS / LibreOffice 中直接编辑每个元素。`,
          details: { path: outputPath, pages: normalized.pages.length, bytes: buffer.length },
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });
}

// ───────── L2: PPT-Master runtime channel (vendored skill, Phase A) ─────────

function registerMasterTools() {
  void pi.agent.registerTool({
    name: "ppt_master_status",
    description:
      "Check the PPT-Master (L2 精制引擎, vendored ppt-master) Python runtime and get the paths needed to run it. Takes no parameters. Returns { stage: ready|venv-missing|guard-failed|deps-missing, skillDir, pythonPath, doctor }. ALWAYS call this first before any PPT-Master work: use the returned skillDir/pythonPath for every subsequent script invocation — never guess or search for paths. If not ready, follow doctor (usually: call ppt_master_setup, or fall back to slides_export).",
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
            : "未就绪：按 doctor 提示处理；用户着急时可先用 slides_export（L1 快速引擎）保底",
      };
      return {
        content: `PPT-Master 运行时：${payload.stage}\n${payload.doctor || ""}\n${payload.hint}\n\`\`\`json\n${JSON.stringify({ stage: payload.stage, skillDir: payload.skillDir, pythonPath: payload.pythonPath }, null, 2)}\n\`\`\``,
        details: payload,
      };
    },
  });

  void pi.agent.registerTool({
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

  void pi.agent.registerTool({
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

  void pi.agent.registerTool({
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
  void pi.agent.registerTool({
    name: "ppt_script",
    description:
      "Run a whitelisted vendored PPT-Master script with the isolated venv (argparse-faithful args). Whitelist: project_manager(init/import-sources/validate) | source_to_md | text_measure(calibrate) | quality_checker(early/final gates) | finalize_svg | total_md_split | svg_to_pptx | image_search | pptx_template_import. finalize/total_md_split/svg_to_pptx are EXPORT-GATED: they refuse unless the user confirmed Stage-2 in the confirm card (or explicitly waived). Runs sync up to 60s, then continues as a background job — poll ppt_job_status. PDF routes are disabled (AGPL).",
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
      const plan = planScript({
        pluginDir: getPluginDir(),
        script: input?.script,
        args: input?.args,
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
        return {
          content: `${plan.summary}\n\n${(result.stdout || result.stderr || "ok").slice(-4000)}`,
          details: { script: input.script, argv: plan.argv, exit: 0 },
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });

  void pi.agent.registerTool({
    name: "ppt_stage_submit",
    description:
      "Submit your design recommendations for user confirmation (PPT-Master Stage-1 沟通契约+模板选择, or Stage-2 三个设计方向). The pending decision renders inside the PPT workbench panel (bottom section) — the user confirms there; no popup opens. Then STOP and wait: silence confirms nothing. Input: { projectDir, stage: stage1|stage2, recommendations }. After submitting, tell the user what to look at and poll ppt_stage_status; do NOT proceed past a ⛔ BLOCKING gate until status returns confirmed/waived.",
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
      // FR-PPT-16: cost estimate rides every submission; stage-2 refuses when
      // the configured deck budget is exceeded (settings → budgetTokens).
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
      const verdict = submitStage(projectDir, stage, args?.recommendations);
      if (verdict.error) return { error: verdict.error };
      return { ...verdict, estimate: estimate.estimate };
      pendingConfirm = { projectDir, stage, submittedAt: verdict.state.stages[stage]?.submittedAt ?? null };
      // The docked workbench polls for this pending decision and renders it at
      // the bottom of the panel; no floating popup anymore. Keep a native
      // notification so the user knows a decision is waiting even when the
      // workbench tab is closed (the command-palette card stays as fallback).
      try {
        pi.ui.showNativeNotification?.("PPT 设计方案待确认", "打开右侧 PPT 工作台，在下方确认（或从命令面板运行「打开 PPT 确认卡」）");
      } catch {
        /* notifications optional */
      }
      return {
        content: `已提交 ${stage} 设计方案：请在右侧 PPT 工作台下方的「设计确认」区选择并提交（若工作台未打开，请先在面板「+」中打开它；或从命令面板运行「打开 PPT 确认卡」）。**现在停下等待用户操作**——沉默不构成确认。用户操作后用 ppt_stage_status(projectDir, stage) 查询结果；等待期间不要推进任何 ⛔ BLOCKING 之后的步骤。`,
        details: { statePath: join(projectDir, "laboflow", "pipeline-state.json") },
      };
    },
  });

  void pi.agent.registerTool({
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
        return {
          content: `${stage}：${verdict.status}${verdict.warning ? `\n${verdict.warning}` : ""}${verdict.message ? `\n${verdict.message}` : ""}`,
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

// ───────────────────────── Panel bridge (confirm card + workbench) ─────────────────────────

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
  };
}

export async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
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
      };
    }
    case "ppt.confirmStage": {
      const projectDir = String(payload.projectDir ?? "");
      const stage = String(payload.stage ?? "");
      const waive = payload.waive === true;
      const verdict = confirmStage(projectDir, stage, { waive, waiveReason: payload.waiveReason });
      if (verdict.error) return { error: verdict.error };
      if (pendingConfirm?.projectDir === projectDir && pendingConfirm?.stage === stage) {
        pendingConfirm = null;
      }
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
}

// Exposed for host-side smoke checks.
export const __internals = { normalizeOutline };
