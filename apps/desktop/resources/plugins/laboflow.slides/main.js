/**
 * Slides L1 — bundled first-party plugin (module 06, plan T56.1).
 *
 * Two agent tools: `slides_plan` normalizes/validates the outline the AGENT
 * drafted from the conversation (pure data shaping — no second model call),
 * `slides_export` writes the confirmed outline as an editable .pptx next to
 * the workspace. All heavy logic lives in ./lib/slides.js so it stays
 * testable without a plugin host.
 */

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { exportDeckToBuffer, normalizeOutline, sanitizeFileName } from "./lib/slides.js";
import {
  detectRuntime,
  ensureRuntime,
  runVendoredScript,
} from "./lib/ppt-runtime.js";

let toolsRegistered = false;
let l2ToolsRegistered = false;

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

export function onLoad() {
  if (toolsRegistered) return;
  toolsRegistered = true;

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

// ───────────────────────── L2: PPT-Master (vendored skill) ─────────────────────────
// The vendored skill corpus guides the agent; these tools expose its
// deterministic Python tail (quality gate → finalize → export) with the
// isolated venv. PyMuPDF/pandoc routes are DISABLED (AGPL/GPL guard).

const L2_TOOLS = [
  {
    name: "ppt_master_status",
    description:
      "Report the PPT-Master (L2 精制引擎) Python runtime status: ready / venv-missing / guard-failed with diagnostics. Takes no parameters. Call before L2 generation; if not ready, tell the user to run ppt_master_setup or fall back to slides_export (L1).",
    risk: "low",
    schema: { type: "object", properties: {} },
    execute: async () => {
      const status = await detectRuntime({ pluginDir: getPluginDir() });
      return {
        content: JSON.stringify(status, null, 2),
        details: status,
      };
    },
  },
  {
    name: "ppt_master_setup",
    description:
      "Install the isolated PPT-Master Python runtime (venv + MIT-only requirements + AGPL guard). Long-running; call only when the user asked to set up the L2 engine or approved the install prompt.",
    risk: "medium",
    schema: {
      "type": "object",
      "properties": {},
    },
    execute: async () => {
      const status = await ensureRuntime({ pluginDir: getPluginDir() }, (line) =>
        pi.log?.("info", line),
      );
      return {
        content:
          status.stage === "ready"
            ? `L2 运行环境就绪（${status.pythonPath}）`
            : `L2 运行环境未就绪（${status.stage}）：${status.diag ?? ""}`,
        details: status,
      };
    },
  },
  {
    name: "ppt_quality",
    description:
      "Run the vendored SVG quality checker over a deck workspace (blocking gate before export). Input: { deckDir, page? } where deckDir contains the svg_output/ pages (P01.svg…).",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        deckDir: { type: "string", description: "Absolute deck workspace directory" },
      },
      required: ["deckDir"],
    },
    execute: async (args) => runL2Script("scripts/svg_quality_checker.py", args, 5 * 60_000),
  },
  {
    name: "ppt_finalize",
    description:
      "Finalize a generated deck: normalize SVGs into svg_final/ and split the speaker-notes markdown. Input: { deckDir, deckTitle? }.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        deckDir: { type: "string" },
        deckTitle: { type: "string" },
      },
      required: ["deckDir"],
    },
    execute: async (args) => {
      const first = await runL2Script("scripts/finalize_svg.py", { deckDir: args?.deckDir }, 10 * 60_000);
      if (first.error) return first;
      const second = await runL2Script("scripts/total_md_split.py", { deckDir: args?.deckDir, deckTitle: args?.deckTitle }, 5 * 60_000);
      return second.error ? second : { content: `${first.content}\n${second.content}` };
    },
  },
  {
    name: "ppt_export",
    description:
      "Convert the finalized SVG deck into a native editable .pptx via the vendored converter (svg_to_pptx.py) and run its postflight report. PDF and PyMuPDF routes are disabled. Input: { deckDir, fileName? }. Call ppt_quality first; the checker must pass.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        deckDir: { type: "string" },
        fileName: { type: "string" },
      },
      required: ["deckDir"],
    },
    execute: async (args) => {
      const outputName = `${sanitizeFileName(args?.fileName || "deck")}.pptx`;
      const outputPath = join(await resolveSlidesOutputDir(), outputName);
      const result = await runL2Script(
        "scripts/svg_to_pptx.py",
        { deckDir: args?.deckDir, extra: ["-o", outputPath, "-s", String(args?.deckDir ?? "."), "-f", "ppt169"] },
        15 * 60_000,
      );
      if (result.error) return result;
      return {
        content: `${result.content}\n已导出可编辑 PPTX：${outputPath}`,
        details: { path: outputPath },
      };
    },
  },
];

function getPluginDir() {
  // The plugin host loads main.js from <pluginDir>/main.js.
  return new URL(".", import.meta.url).pathname.replace(/\/$/, "");
}

async function resolveSlidesOutputDir() {
  let root = "";
  try {
    const workspace = await pi.workspace.get();
    root = String(workspace?.path ?? "");
  } catch {
    root = "";
  }
  const settings = await pi.plugin.getSettings().catch(() => ({}));
  const folder = String(settings?.outputDir ?? "slides").replace(/^\/+|\/+$/g, "") || "slides";
  return root ? join(root, folder) : join(process.cwd(), folder);
}

async function runL2Script(scriptRelPath, args, timeoutMs) {
  const deckDir = String(args?.deckDir ?? "").trim();
  if (!deckDir) return { error: "deckDir is required" };
  const scriptArgs = args?.extra ?? [];
  try {
    const result = await runVendoredScript(
      { pluginDir: getPluginDir() },
      scriptRelPath,
      scriptArgs,
      { cwd: deckDir, timeoutMs },
    );
    const text = `${result.stdout}${result.stderr}`;
    if (result.code !== 0) {
      return { error: `${scriptRelPath} 退出码 ${result.code}：${text.slice(-1500)}` };
    }
    return { content: text.slice(-4000) || "ok" };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

function registerL2Tools() {
  if (l2ToolsRegistered) return;
  for (const tool of L2_TOOLS) {
    void pi.agent.registerTool(tool);
  }
  l2ToolsRegistered = true;
}

export function onUnload() {
  toolsRegistered = false;
  l2ToolsRegistered = false;
}

// Exposed for host-side smoke checks.
export const __internals = { normalizeOutline };
