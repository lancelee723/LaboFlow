/**
 * FR-TC-10 按评论修订: aggregate a node's open comments with its document
 * content, ask the session model for a structured revision set, and create
 * the suggestions server-side (producedBy='agent'). Pure prompt/parse logic
 * lives here so tests cover the contract without an LLM.
 */

export type ReviewComment = {
  id: string;
  authorId: string | null;
  body: string;
  status: string;
  anchor?: { textPrefix?: string; textHash?: string } | null;
};

export type ReviewSuggestionDraft = {
  originalText: string;
  revisedText: string;
  rationale: string;
};

export const REVIEW_SYSTEM_PROMPT = [
  "你是文档修订助手。根据评论对文档提出「修订建议」：不覆盖原文，只产出建议集。",
  "只输出 JSON 数组，每项字段：",
  '- "originalText"：文档中被评论段落的原文片段（逐字复制，8-120 字，保证能在文档中唯一定位）',
  '- "revisedText"：修改后的文本',
  '- "rationale"：修改理由（一句话，中文）',
  "规则：只处理评论明确要求的修改；原文片段必须逐字来自文档；无法定位的评论跳过；",
  "没有可产出的建议时输出 []。",
].join("\n");

export function buildReviewUserPrompt(docContent: string, comments: ReviewComment[]): string {
  const numbered = comments
    .map((comment, index) => {
      const anchor = comment.anchor?.textPrefix ? `（位置：…${comment.anchor.textPrefix}…）` : "";
      return `${index + 1}. [${comment.id}] ${anchor}${comment.body}`;
    })
    .join("\n");
  return `文档正文：\n"""\n${docContent}\n"""\n\n待处理评论：\n${numbered}\n\n请输出 JSON 数组。`;
}

/** Tolerant JSON extraction: models wrap arrays in prose or fences. */
export function parseReviewSuggestions(text: string): ReviewSuggestionDraft[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ReviewSuggestionDraft[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const originalText = String((entry as Record<string, unknown>).originalText ?? "").trim();
    const revisedText = String((entry as Record<string, unknown>).revisedText ?? "").trim();
    if (!originalText || !revisedText) continue;
    out.push({
      originalText,
      revisedText,
      rationale: String((entry as Record<string, unknown>).rationale ?? "").trim(),
    });
  }
  return out;
}

/**
 * FR-TC-12 划词 AI 就地改: rewrite ONE selection in place. The renderer
 * collects the selection and an optional instruction; the result feeds the
 * existing revision-suggestion dialog (human reviews before submit), so the
 * revision pipeline — anchors, hashing, accept/reject — stays the only write
 * path. Pure prompt/cleanup logic lives here like the review prompts above.
 */

export const REWRITE_SYSTEM_PROMPT = [
  "你是文档编辑助手。把用户选中的文本就地改写：只输出改写后的文本本身。",
  "规则：不改写选区之外的任何内容；保留原有的 Markdown 结构（标题/列表/表格/代码块）；",
  "不解释、不加前言后语、不用引号包裹；无法执行指令时原样返回选区文本。",
].join("\n");

export function buildRewriteUserPrompt(
  selectedText: string,
  instruction: string,
  context?: { before?: string; after?: string },
): string {
  const before = (context?.before ?? "").slice(-400);
  const after = (context?.after ?? "").slice(0, 400);
  return [
    before ? `选区前文（仅供理解上下文，不要输出）：\n"""\n${before}\n"""` : "",
    `选区文本（就地改写它）：\n"""\n${selectedText}\n"""`,
    instruction.trim()
      ? `改写指令：${instruction.trim()}`
      : "改写指令：使表达更精炼、更专业，其余保持原意。",
    after ? `选区后文（仅供理解上下文，不要输出）：\n"""\n${after}\n"""` : "",
    "只输出改写后的选区文本。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Models occasionally wrap the rewrite in fences or echo quotes; strip them. */
export function cleanRewriteOutput(text: string, originalText: string): string {
  let out = text.trim();
  const fence = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(out);
  if (fence) out = fence[1].trim();
  if (
    out.length > 1 &&
    ((out.startsWith('"') && out.endsWith('"')) ||
      (out.startsWith("“") && out.endsWith("”")))
  ) {
    out = out.slice(1, -1).trim();
  }
  // A model that answered with prose about the task instead of the rewrite
  // would corrupt the document on accept; falling back to the original makes
  // the no-op visible in the dialog instead.
  if (!out || out === originalText.trim()) return originalText;
  return out;
}
