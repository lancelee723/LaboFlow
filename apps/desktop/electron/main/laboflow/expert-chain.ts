/**
 * FR-E-17: serial multi-expert dispatch (`@A 做X，然后 @B 做Y`).
 *
 * The renderer's mention parser (`expert-mention.ts`) turns such a prompt
 * into ordered steps; this module executes them one at a time against the
 * same durable driver a single dispatch uses. Step N+1 starts only after
 * step N's turn settles, and its task carries step N's final output as an
 * explicit upstream-artifact block — the "中间产物" the PRD names — so the
 * later expert builds on real results instead of re-doing the work.
 *
 * Progress lands as cards in the ORIGIN session (where the prompt was
 * typed), one per step, so the chain stays readable in the transcript that
 * started it. A step that ends non-completed stops the chain right there —
 * the remaining steps keep their original tasks rather than running without
 * their upstream input. Like team runs, the chain lives in main-process
 * memory: a renderer reload is fine, an app quit abandons the remaining
 * steps (the cards show how far it got).
 */
/** One resolved `@专家` step from the renderer parser, in execution order. */
export interface ExpertChainStep {
  expertId: string;
  name: string;
  task: string;
}

export interface ExpertChainDeps {
  invokeWithCompletion(request: {
    sessionId?: string;
    expertId: string;
    task: string;
  }): Promise<{
    sessionId: string;
    completion: Promise<{
      status: "completed" | "aborted" | "error";
      finalText: string;
    }>;
  }>;
  postSessionCard(sessionId: string, message: {
    id: string;
    role: "assistant";
    content: string;
    createdAt: string;
    status: "complete";
    kind?: string;
  }): Promise<void>;
  broadcast(event: unknown): void;
  logger: {
    app(scope: string, level: string, message: string, data?: unknown): void;
  };
}

/** Chain card kind in the transcript, distinct from single-dispatch cards. */
const CHAIN_CARD_KIND = "expert-chain";

/** Upstream output longer than this stops dominating the next expert's task. */
const UPSTREAM_CLIP_CHARS = 4000;

function chainId(): string {
  return `chain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clip(text: string, maxChars = UPSTREAM_CLIP_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（已截断）`;
}

/**
 * Fire-and-forget the serial chain; resolves with the FIRST step's session so
 * the caller can surface it immediately (single-dispatch UX unchanged).
 */
export async function startExpertChain(
  deps: ExpertChainDeps,
  steps: ExpertChainStep[],
  originSessionId: string | undefined,
): Promise<{ firstSessionId: string | undefined }> {
  const runId = chainId();
  const firstSessionId = await dispatchStep(
    deps,
    runId,
    steps,
    0,
    originSessionId,
    undefined,
    undefined,
  );
  return { firstSessionId };
}

async function dispatchStep(
  deps: ExpertChainDeps,
  runId: string,
  steps: ExpertChainStep[],
  index: number,
  originSessionId: string | undefined,
  upstream: string | undefined,
  upstreamName: string | undefined,
): Promise<string | undefined> {
  const step = steps[index];
  const task = upstream
    ? `${step.task}\n\n---\n上游专家「${upstreamName}」的产出（作为你的输入材料，可直接引用，不要重复其工作）：\n\n${clip(upstream)}`
    : step.task;
  try {
    const { sessionId, completion } = await deps.invokeWithCompletion({
      sessionId: index === 0 ? originSessionId : undefined,
      expertId: step.expertId,
      task,
    });
    deps.broadcast({
      runId,
      sessionId,
      type: "chain",
      payload: { expert: step.name, index, total: steps.length, status: "running" },
    });
    void completion
      .then(async (result) => {
        await settleStep(
          deps,
          runId,
          steps,
          index,
          originSessionId,
          sessionId,
          step,
          result,
        );
      })
      .catch(async (error: unknown) => {
        deps.logger.app("expert-chain", "warn", "chain step failed", {
          runId,
          expert: step.name,
          data: String(error),
        });
        await postStepCard(
          deps,
          originSessionId,
          `【专家链 · ${index + 1}/${steps.length} 失败】\n\n${step.name} 的执行异常，链已停止。`,
        );
      });
    return sessionId;
  } catch (error) {
    deps.logger.app("expert-chain", "warn", "chain step dispatch failed", {
      runId,
      expert: step.name,
      data: String(error),
    });
    void postStepCard(
      deps,
      originSessionId,
      `【专家链 · 受阻】\n\n${step.name} 无法启动，链已停止（第 ${index + 1}/${steps.length} 步）。`,
    );
    return undefined;
  }
}

async function settleStep(
  deps: ExpertChainDeps,
  runId: string,
  steps: ExpertChainStep[],
  index: number,
  originSessionId: string | undefined,
  sessionId: string,
  step: ExpertChainStep,
  result: { status: "completed" | "aborted" | "error"; finalText: string },
): Promise<void> {
  deps.broadcast({
    runId,
    sessionId,
    type: "chain",
    payload: { expert: step.name, index, total: steps.length, status: result.status },
  });
  if (result.status !== "completed" || !result.finalText.trim()) {
    await postStepCard(
      deps,
      originSessionId,
      `【专家链 · ${index + 1}/${steps.length} 未完成】\n\n${step.name} 以 ${result.status} 结束，链已停止；后续步骤未派发。`,
    );
    return;
  }
  const next = steps[index + 1];
  if (!next) {
    await postStepCard(
      deps,
      originSessionId,
      `【专家链 · 完成】\n\n全部 ${steps.length} 步已完成：\n${steps
        .map((s, i) => `${i + 1}. ${s.name}`)
        .join("\n")}\n\n各步结果见各自的会话。`,
    );
    return;
  }
  await postStepCard(
    deps,
    originSessionId,
    `【专家链 · ${index + 1}/${steps.length} 完成】\n\n${step.name} ✓ → 正在指派 ${next.name}（${index + 2}/${steps.length}），其产出将作为上游材料传入。`,
  );
  await dispatchStep(
    deps,
    runId,
    steps,
    index + 1,
    originSessionId,
    result.finalText,
    step.name,
  );
}

async function postStepCard(
  deps: ExpertChainDeps,
  sessionId: string | undefined,
  content: string,
): Promise<void> {
  if (!sessionId) return;
  try {
    await deps.postSessionCard(sessionId, {
      id: `${CHAIN_CARD_KIND}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
      status: "complete",
      kind: CHAIN_CARD_KIND,
    });
  } catch (error) {
    deps.logger.app("expert-chain", "warn", "chain card post failed", {
      data: String(error),
    });
  }
}
