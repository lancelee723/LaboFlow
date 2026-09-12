/**
 * Task envelope for dispatched expert/team runs (module 01 refinement, Q2).
 * Pure helper so the send path stays thin and the envelope stays testable.
 */

/** Minimal draft shape the envelope needs (structural subset of the composer snapshot). */
export interface ExpertDispatchDraft {
  fileReferences?: ReadonlyArray<{ path?: string }>;
}

/**
 * Envelope for a dispatched expert/team task: the user's prompt plus the
 * draft's *explicit* context only. Attached file chips — including the scratch
 * transcripts written by `@`-conversation references — are listed as readable
 * paths the expert opens with its own tools; nothing is inlined and no
 * conversation history is carried implicitly (Workbuddy semantics: an expert
 * processes the conversation and files the user provides).
 */
export function buildExpertDispatchTask(
  task: string,
  draft?: ExpertDispatchDraft | null,
): string {
  const paths = (draft?.fileReferences ?? [])
    .map((reference) => reference.path ?? "")
    .filter(Boolean);
  if (!paths.length) return task;
  const listed = paths.map((path) => `- ${path}`).join("\n");
  return `${task}\n\n[上下文]\n用户为本任务附加了以下文件（含引用会话的转录稿），可直接读取：\n${listed}`;
}
