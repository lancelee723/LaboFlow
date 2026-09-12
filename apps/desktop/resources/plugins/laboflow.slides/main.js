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
import { join } from "node:path";

import { exportDeckToBuffer, normalizeOutline, sanitizeFileName } from "./lib/slides.js";
import {
  detectRuntime,
  ensureRuntime,
  findForbiddenDistributions,
  freezeDistributions,
  resolveRuntimeRoot,
  skillRoot,
  venvPythonPath,
} from "./lib/ppt-runtime.js";
import { createJobManager } from "./lib/ppt-jobs.js";
import { listDocDir, MAX_DOC_BYTES, resolveDocEntry } from "./lib/ppt-read-doc.js";

let toolsRegistered = false;
let jobManager = null;
let activeSetupJobId = null;

function getPluginDir() {
  // The plugin host loads main.js from <pluginDir>/main.js.
  return new URL(".", import.meta.url).pathname.replace(/\/$/, "");
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
      const status = await detectRuntime(deps());
      const skillDir = skillRoot(getPluginDir());
      const venvPython = venvPythonPath(resolveRuntimeRoot(deps()));
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
      if (activeSetupJobId) {
        const existing = jobManager.get(activeSetupJobId);
        if (existing && !["succeeded", "failed", "cancelled", "interrupted"].includes(existing.status)) {
          return {
            content: `已有安装作业进行中：${activeSetupJobId}（${existing.status}）。用 ppt_job_status 轮询即可，无需重复安装。`,
            details: { jobId: activeSetupJobId, reused: true },
          };
        }
      }
      const settings = await pi.plugin.getSettings().catch(() => ({}));
      const pipMirror = settings?.pipMirror && settings.pipMirror !== "default" ? settings.pipMirror : undefined;
      const submitted = jobManager.submit({
        kind: "ppt-setup",
        run: async (ctx) => {
          const status = await ensureRuntime({ ...deps(), pipMirror, signal: ctx.signal }, ctx.log);
          if (status.stage === "ready") {
            const frozen = await freezeDistributions(deps()).catch(() => null);
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

export function onUnload() {
  toolsRegistered = false;
  jobManager = null;
  activeSetupJobId = null;
}

// Exposed for host-side smoke checks.
export const __internals = { normalizeOutline };
