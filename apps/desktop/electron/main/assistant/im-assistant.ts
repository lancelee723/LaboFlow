/**
 * T53.5 助理会话: one persistent session backing the assistant-mode page and
 * the webhook channel, so remote commands keep cross-turn context (FR-MC-02)
 * and the unified history survives restarts. The session is located by its
 * reserved title — no schema, no new persistence.
 */

import type { HeadlessAgentDriver } from "../headless-agent-driver";
/** Minimal host seam so tests and callers need only the call surface. */
export interface HostCaller {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export const ASSISTANT_SESSION_TITLE = "IM通道";
/** 改名前的历史标题：定位到旧会话时沿用（保历史连续）并改名为新标题。 */
export const LEGACY_ASSISTANT_SESSION_TITLE = "助理模式";

type SessionSummary = { id: string; title?: string | null };

export async function ensureAssistantSession(
  host: HostCaller,
): Promise<{ sessionId: string; created: boolean }> {
  const listed = await host.call<{ sessions?: SessionSummary[] }>("session.list", {});
  const existing = (listed.sessions ?? []).find(
    (session) => (session.title ?? "").trim() === ASSISTANT_SESSION_TITLE,
  );
  if (existing) return { sessionId: existing.id, created: false };
  const legacy = (listed.sessions ?? []).find(
    (session) => (session.title ?? "").trim() === LEGACY_ASSISTANT_SESSION_TITLE,
  );
  if (legacy) {
    await host
      .call("session.rename", { id: legacy.id, title: ASSISTANT_SESSION_TITLE })
      .catch(() => undefined);
    return { sessionId: legacy.id, created: false };
  }
  const created = await host.call<{ session?: { id?: string } }>("session.create", {
    title: ASSISTANT_SESSION_TITLE,
  });
  const sessionId = created.session?.id ?? "";
  if (!sessionId) throw new Error("assistant session create failed");
  return { sessionId, created: true };
}

/** 统一对话历史（FR-MC-01）：直接复用会话条目流，落盘天然持久。 */
export async function assistantHistory(
  host: HostCaller,
  sessionId: string,
): Promise<Array<{ role?: string; content?: string; createdAt?: string }>> {
  const detail = await host.call<{ session?: { messages?: Array<{ role?: string; content?: string; createdAt?: string }> } }>(
    "session.get",
    { id: sessionId },
  );
  return detail.session?.messages ?? [];
}

/** 派发一条助理指令（页面输入与 webhook 共用），完成后回传最终文本。 */
export async function dispatchAssistantTurn(
  driver: HeadlessAgentDriver,
  sessionId: string,
  message: string,
): Promise<{ sessionId: string; finalText: string; status: string }> {
  const handle = await driver.start({
    sessionId,
    prompt: message,
    timeoutMs: 15 * 60_000,
  });
  const result = await handle.completion;
  return { sessionId, finalText: result.finalText, status: result.status };
}
