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
