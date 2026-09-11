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

let toolsRegistered = false;

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

export function onUnload() {
  toolsRegistered = false;
}

// Exposed for host-side smoke checks.
export const __internals = { normalizeOutline };
