/**
 * FR-MC-17/18 无人值守权限策略: headless sessions (scheduled tasks, webhook,
 * channel commands, background expert dispatch) declare how ask-class tool
 * calls resolve without a human —
 *   strict   定时任务默认: auto-deny the call, keep the task running
 *   degraded 远程指令默认: surface the approval card, auto-deny after 30min
 *   lenient  explicit opt-in: behaves like an attended session (passthrough)
 * Interactive sessions never register, so the chat path is untouched.
 */

import { IPC } from "@pi-desktop/shared";

export type UnattendedPolicy = "strict" | "degraded" | "lenient";

type Registration = { policy: UnattendedPolicy };

const registry = new Map<string, Registration>();
const degradeTimers = new Map<string, ReturnType<typeof setTimeout>>();

const DEGRADE_TIMEOUT_MS = 30 * 60_000;

export function registerUnattendedPolicy(sessionId: string, policy: UnattendedPolicy): void {
  registry.set(sessionId, { policy });
}

export function clearUnattendedPolicy(sessionId: string): void {
  registry.delete(sessionId);
  const timer = degradeTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    degradeTimers.delete(sessionId);
  }
}

export function unattendedPolicyOf(sessionId: string): UnattendedPolicy | null {
  return registry.get(sessionId)?.policy ?? null;
}

export type UnattendedAsk = {
  requestId: string;
  sessionId: string;
  toolName: string;
  argsPreview: string;
};

export type UnattendedAskDeps = {
  /** Resolve a pending permission on the host (deny path). */
  resolve: (requestId: string, decision: "deny") => Promise<void>;
  /** Renderer/notification sink (approval loop, denials). */
  notify: (payload: Record<string, unknown>) => void;
  log: (level: string, message: string) => void;
  now?: () => number;
};

/**
 * Gate a permission request. Returns true when this module fully handled it
 * (strict auto-deny) — the caller must NOT forward the request to the UI.
 * Degraded forwards to the UI but arms the 30-minute auto-deny.
 */
export function interceptUnattendedAsk(
  permission: UnattendedAsk,
  deps: UnattendedAskDeps,
): boolean {
  const policy = unattendedPolicyOf(permission.sessionId);
  if (!policy || policy === "lenient") return false;
  const label = `${permission.toolName}(${permission.argsPreview.slice(0, 80)})`;
  if (policy === "strict") {
    deps.log("info", `unattended strict auto-deny: ${label}`);
    void deps
      .resolve(permission.requestId, "deny")
      .catch((error) => deps.log("warn", `strict deny failed: ${String(error)}`));
    deps.notify({
      kind: "unattended.denied",
      event: IPC.event.toast,
      sessionId: permission.sessionId,
      message: `无人值守（严格）：已自动拒绝 ${permission.toolName}`,
    });
    return true;
  }
  // degraded: surface the approval card (fall through) with a deny deadline.
  if (!degradeTimers.has(permission.requestId)) {
    const timer = setTimeout(() => {
      degradeTimers.delete(permission.requestId);
      deps.log("info", `unattended degraded timeout auto-deny: ${label}`);
      void deps
        .resolve(permission.requestId, "deny")
        .catch((error) => deps.log("warn", `degraded deny failed: ${String(error)}`));
      deps.notify({
        kind: "unattended.denied",
        sessionId: permission.sessionId,
        message: `无人值守（降级）：30 分钟未响应，已自动拒绝 ${permission.toolName}`,
      });
    }, DEGRADE_TIMEOUT_MS);
    degradeTimers.set(permission.requestId, timer);
  }
  deps.notify({
    kind: "unattended.approval-requested",
    sessionId: permission.sessionId,
    message: `无人值守审批：${label}`,
    requestId: permission.requestId,
  });
  return false;
}

/** Resolution arrived (any decision) — clear the degrade deadline. */
export function settleUnattendedAsk(requestId: string): void {
  const timer = degradeTimers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    degradeTimers.delete(requestId);
  }
}

/** Test seam: forget all state. */
export function resetUnattendedPolicies(): void {
  registry.clear();
  for (const timer of degradeTimers.values()) clearTimeout(timer);
  degradeTimers.clear();
}
