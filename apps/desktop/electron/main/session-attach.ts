/**
 * ZCode-style "add context": export another conversation's transcript as a
 * markdown attachment in the current session's scratch directory, so the
 * composer can reference it like any imported file (PRD FR-C-34 semantics —
 * link a historical session as task context).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AttachedSessionFile = {
  path: string;
  name: string;
  kind: "file";
};

type TranscriptMessage = {
  role?: string;
  content?: string;
  createdAt?: string;
};

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const MAX_TOTAL_CHARS = 120_000;
const MAX_MESSAGE_CHARS = 20_000;

function roleLabel(role: string | undefined): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  return role || "消息";
}

export function renderSessionMarkdown(
  title: string,
  messages: TranscriptMessage[],
): string {
  const parts: string[] = [`# 对话记录：${title || "未命名对话"}`, ""];
  let total = 0;
  for (const message of messages) {
    if (message.role === "tool") continue;
    const content = (message.content ?? "").trim();
    if (!content) continue;
    const when = message.createdAt ? ` · ${message.createdAt}` : "";
    const clipped =
      content.length > MAX_MESSAGE_CHARS
        ? `${content.slice(0, MAX_MESSAGE_CHARS)}…（已截断）`
        : content;
    const block = `## ${roleLabel(message.role)}${when}\n\n${clipped}\n`;
    total += block.length;
    if (total > MAX_TOTAL_CHARS) {
      parts.push("\n（对话过长，已截断）\n");
      break;
    }
    parts.push(block);
  }
  return parts.join("\n");
}

function safeFileName(title: string, fallback: string): string {
  const base = (title || fallback)
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || fallback}.md`;
}

export async function attachSessionTranscript(
  dataDir: string,
  targetSessionId: string,
  title: string,
  messages: TranscriptMessage[],
): Promise<AttachedSessionFile> {
  if (!SAFE_SESSION_ID.test(targetSessionId)) {
    throw new Error("invalid session id");
  }
  const scratchDir = join(dataDir, "scratch", targetSessionId);
  await mkdir(scratchDir, { recursive: true });
  const name = safeFileName(title, "conversation");
  const path = join(scratchDir, name);
  await writeFile(path, renderSessionMarkdown(title, messages), "utf8");
  return { path, name, kind: "file" };
}

/** Team-space doc attachment (FR-TC-17): export a server-side space document
 * into the session scratch directory so the composer can reference it like an
 * imported file. The agent reads the snapshot with the user's own rights —
 * the fetch itself already went through the server's permission filter. */

const MAX_SPACE_DOC_CHARS = 400_000;

const SPACE_DOC_EXTENSIONS: Record<string, string> = {
  md: ".md",
  csv: ".csv",
  html: ".html",
};

export function renderSpaceDocMarkdown(
  docName: string,
  spaceName: string,
  content: string,
): string {
  const header = `# 团队空间文档：${docName}\n\n（来源空间：${spaceName}）\n\n`;
  if (content.length > MAX_SPACE_DOC_CHARS) {
    return `${header}${content.slice(0, MAX_SPACE_DOC_CHARS)}\n\n（文档过长，已截断）\n`;
  }
  return `${header}${content}\n`;
}

function spaceDocFileName(docName: string, docType: string): string {
  const base = (docName || "document")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "document";
  const ext = SPACE_DOC_EXTENSIONS[docType] ?? ".md";
  return base.endsWith(ext) ? base : `${base}${ext}`;
}

export async function attachSpaceDoc(
  dataDir: string,
  targetSessionId: string,
  docName: string,
  docType: string,
  spaceName: string,
  content: string,
): Promise<AttachedSessionFile> {
  if (!SAFE_SESSION_ID.test(targetSessionId)) {
    throw new Error("invalid session id");
  }
  const scratchDir = join(dataDir, "scratch", targetSessionId);
  await mkdir(scratchDir, { recursive: true });
  const name = spaceDocFileName(docName, docType);
  const path = join(scratchDir, name);
  await writeFile(path, renderSpaceDocMarkdown(docName, spaceName, content), "utf8");
  return { path, name, kind: "file" };
}
