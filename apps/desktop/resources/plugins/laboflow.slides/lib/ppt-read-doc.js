/**
 * ppt_read_doc — read-only bridge into the vendored PPT-Master corpus
 * (module 06 L2, DEVPLAN Phase A).
 *
 * The agent's Read tool is sandboxed to the workspace and cannot reach the
 * app bundle where the vendored skill lives; raw `cat` over Bash would trip
 * permission prompts. This lib resolves corpus-relative paths against a
 * strict whitelist (text docs + template indexes only — never the 12k SVGs
 * or python sources), refuses traversal/symlink escapes, and caps responses
 * at 1 MiB per call. Pure path logic lives here; the tool wires pi.* around
 * it in main.js.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_DOC_BYTES = 1024 * 1024;

/** Top-level corpus entries an agent may read. */
export const DOC_ALLOWLIST = [
  "SKILL.md",
  "VENDOR_README.md",
  "workflows",
  "references",
  "scripts/docs",
];

const TEXT_SUFFIXES = [".md", ".txt", ".json", ".yaml", ".yml"];
const TEMPLATES_DOC = /^templates\/[^/]+$/; // templates/<entry> listing
const TEMPLATES_DOC_FILE = /^templates\/[^/]+\/[^/]+$/; // templates/<entry>/<file.md|*_index.json>

/** Normalize user input to a corpus-relative POSIX-ish path or reject. */
export function normalizeRelPath(input) {
  let rel = String(input ?? "").trim().replace(/\\/g, "/");
  rel = rel.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || rel.includes("\0")) return null;
  if (isAbsolute(input ?? "")) return null;
  return rel;
}

/**
 * Decide whether a corpus-relative path is readable and resolve it.
 * Returns { ok: true, absPath, kind: "file" | "dir" } or { ok: false, reason }.
 */
export function resolveDocEntry(rootDir, input) {
  const rel = normalizeRelPath(input);
  if (!rel) return { ok: false, reason: "路径不合法：请给出语料库相对路径（如 workflows/routing.md）" };

  const allowed =
    DOC_ALLOWLIST.some((entry) => rel === entry || rel.startsWith(`${entry}/`)) ||
    TEMPLATES_DOC.test(rel) ||
    (TEMPLATES_DOC_FILE.test(rel) &&
      (rel.endsWith(".md") || rel.endsWith("_index.json")));
  if (!allowed) {
    return {
      ok: false,
      reason:
        "不在可读白名单内（允许：SKILL.md、VENDOR_README.md、workflows/**、references/**、scripts/docs/**、templates/<分类>[_index.json|.md]）。图片/SVG 与 Python 源码不提供读取。",
    };
  }

  const rootReal = realpathSync(rootDir);
  const absPath = resolve(rootDir, rel);
  const container = resolve(absPath, "..");
  let containerReal;
  try {
    containerReal = realpathSync(container);
  } catch {
    return { ok: false, reason: "路径不存在" };
  }
  if (!containerReal.startsWith(rootReal + sep) && containerReal !== rootReal) {
    return { ok: false, reason: "路径越界（符号链接逃逸）" };
  }

  let st;
  try {
    st = statSync(absPath);
    // The final path itself may be a symlink out of the corpus (or sit under
    // a symlinked ancestor) — realpath the entry, not just its container.
    const entryReal = realpathSync(absPath);
    if (!entryReal.startsWith(rootReal + sep) && entryReal !== rootReal) {
      return { ok: false, reason: "路径越界（符号链接逃逸）" };
    }
  } catch {
    return { ok: false, reason: "路径不存在" };
  }
  if (st.isDirectory()) {
    // Directories must themselves be whitelist members (not e.g. templates/x/y/).
    if (!(DOC_ALLOWLIST.includes(rel) || TEMPLATES_DOC.test(rel))) {
      return { ok: false, reason: "仅允许列出白名单目录本身" };
    }
    return { ok: true, absPath, kind: "dir" };
  }
  if (!st.isFile()) return { ok: false, reason: "不是常规文件" };
  if (!TEXT_SUFFIXES.some((suffix) => rel.toLowerCase().endsWith(suffix))) {
    return { ok: false, reason: "仅允许文本类文件（md/txt/json/yaml）" };
  }
  return { ok: true, absPath, kind: "file" };
}

/** List a whitelisted directory (names + child-dir markers + doc hints). */
export function listDocDir(rootDir, absPath, relForHints = "") {
  const entries = readdirSync(absPath, { withFileTypes: true });
  const names = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  const docish = names.filter((name) =>
    TEXT_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix)),
  );
  return {
    kind: "dir",
    path: relForHints || ".",
    entries: names,
    hint: docish.length
      ? `可读文档示例：${docish.slice(0, 10).join("、")}${docish.length > 10 ? " …" : ""}（用 ppt_read_doc 读取具体文件）`
      : "该目录下暂无可读文档；子目录用 ppt_read_doc 逐层列出。",
  };
}
