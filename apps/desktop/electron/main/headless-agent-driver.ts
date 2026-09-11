/**
 * HeadlessAgentDriver (Phase 5 shared foundation, plan T53.1).
 *
 * Lets Electron main start an agent turn without the renderer: scheduled
 * tasks, IM-triggered prompts and background expert dispatch (module 01)
 * launch through this one driver instead of asking the chat UI to press
 * send. The interactive path (IPC `agentPrompt`) shares the same durable
 * turn core (`beginDurableTurnAndPrompt`) so every path keeps one lifecycle:
 * beginTurn → persisted user message → sidecar `agent.prompt` → agent_end →
 * finishTurn. Main owns the sidecar event stream, so headless turns persist
 * and finalize identically whether or not a window is open.
 */

export type HeadlessRunStatus = "completed" | "aborted" | "error";

export interface HeadlessNewSession {
  title?: string;
  projectPath?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface HeadlessRunRequest {
  /** Existing session to prompt. Omit to create one from `newSession`. */
  sessionId?: string;
  newSession?: HeadlessNewSession;
  prompt: string;
  /** Headless runs are agent-mode only; contract modes need a human. */
  mode?: "agent";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  /** Persona overlay prepended to the harness prompt (module 01 experts). */
  personaPrompt?: string;
  /** Abort the run after this long without settlement. */
  timeoutMs?: number;
}

export interface HeadlessRunResult {
  sessionId: string;
  turnId: string;
  status: HeadlessRunStatus;
  errorCode?: string;
  finalText: string;
  /** Turn token usage when the event stream reported it (team budgets). */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface HeadlessRunHandle {
  sessionId: string;
  turnId: string;
  completion: Promise<HeadlessRunResult>;
}

export interface HeadlessDriverHost {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface HeadlessDriverSidecar {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  setProjectInstructionRoot(sessionId: string, projectPath?: string): void;
  clearProjectInstructionRoot(sessionId: string): void;
  clearVendorAuthBindings(sessionId: string): void;
}

export interface HeadlessLaunch {
  providerId: string;
  modelId: string;
  projectPath?: string;
  sidecarParams: Record<string, unknown>;
}

export interface HeadlessDriverDeps {
  getHost(): HeadlessDriverHost | null;
  getSidecar(): HeadlessDriverSidecar | null;
  resolveLaunch(
    sessionId: string,
    session: unknown,
    settings: unknown,
    overrides?: Record<string, any>,
  ): Promise<HeadlessLaunch>;
  finishTurn(
    sessionId: string,
    status: HeadlessRunStatus,
    errorCode?: string,
  ): Promise<unknown>;
  waitForTurnSettlement(sessionId: string, turnId: string): Promise<void>;
  /** Settlement outcome recorded by `finishTurn`; consumed once. */
  consumeTurnSettlement(
    sessionId: string,
    turnId: string,
  ): {
    status: HeadlessRunStatus;
    errorCode?: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  } | undefined;
  activeTurns: Map<string, any>;
  activeTurnUsages: Map<string, any>;
  sendToRenderer(channel: string, payload: unknown): void;
  agentMessageEvent: string;
  logger: {
    app(
      scope: string,
      level: string,
      message: string,
      data?: unknown,
    ): void;
  };
  defaultTimeoutMs?: number;
  /** Bounded wait for settlement after a timeout abort (tests shorten it). */
  abortGraceMs?: number;
}

export interface DurableTurnInput {
  sessionId: string;
  launch: HeadlessLaunch;
  /** Content bound for the model (fallback paths already appended). */
  modelContent: string;
  /** Fully built user message persisted under the durable turn. */
  userMessage: Record<string, unknown>;
  /** Inline attachment payloads forwarded to the sidecar. */
  attachments?: Array<{
    path: string;
    name: string;
    kind?: string;
    mimeType?: string;
    size?: number;
    data?: string;
  }>;
  /** Echo message_start/end to the renderer (no-op without a window). */
  echoToRenderer?: boolean;
}

export interface DurableTurnResult {
  accepted: boolean;
  turnId: string;
  userMessageId: string;
}

const AGENT_BUSY = "AGENT_BUSY";
const NOT_FOUND = "NOT_FOUND";
const INVALID_ARGUMENT = "INVALID_ARGUMENT";
const HEADLESS_TIMEOUT = "HEADLESS_TIMEOUT";
const CONTRACT_MODE_ERROR = "PLAN_REQUIRES_INTERACTIVE_SESSION";
const ABORT_GRACE_MS = 60_000;

function httpError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * Shared durable-turn core: beginTurn → persist user message → sidecar
 * prompt. The interactive `agentPrompt` handler calls this after its
 * renderer-specific prelude (viewing session, truncation, revisions, slash
 * expansion, attachments); headless runs call it with their simpler input.
 * A failure after beginTurn closes the turn before rethrowing, mirroring the
 * contract the interactive handler has always kept.
 */
export async function beginDurableTurnAndPrompt(
  deps: HeadlessDriverDeps,
  input: DurableTurnInput,
): Promise<DurableTurnResult> {
  const host = deps.getHost();
  const sidecar = deps.getSidecar();
  if (!host || !sidecar) throw new Error("backend unavailable");

  const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
    sessionId: input.sessionId,
    providerId: input.launch.providerId,
    modelId: input.launch.modelId,
  });
  const turnId = String(turn?.turnId ?? "").trim();
  if (!turnId) throw new Error("session.beginTurn returned no turn");
  deps.activeTurns.set(input.sessionId, turnId);
  deps.activeTurnUsages.delete(input.sessionId);

  const userMessageId = String(input.userMessage.id ?? "");
  try {
    await host.call("session.appendMessage", {
      sessionId: input.sessionId,
      message: input.userMessage,
      turnId,
    });
  } catch (error) {
    await deps.finishTurn(
      input.sessionId,
      "error",
      (error as { data?: { errorCode?: string }; errorCode?: string })?.data
        ?.errorCode ??
        (error as { errorCode?: string })?.errorCode,
    );
    throw error;
  }

  if (input.echoToRenderer) {
    deps.sendToRenderer(deps.agentMessageEvent, {
      sessionId: input.sessionId,
      ts: Date.now(),
      event: { type: "message_start", message: input.userMessage },
    });
    deps.sendToRenderer(deps.agentMessageEvent, {
      sessionId: input.sessionId,
      ts: Date.now(),
      event: { type: "message_end", message: input.userMessage },
    });
  }

  let result: { accepted: boolean; turnId: string };
  try {
    result = await sidecar.call<{ accepted: boolean; turnId: string }>(
      "agent.prompt",
      {
        ...input.launch.sidecarParams,
        // The host-created durable turn is the approval identity used by
        // Rust. The runtime must not replace it with a provider-local UUID.
        turnId,
        content: input.modelContent,
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.filter(
                (attachment) => attachment.data,
              ),
            }
          : {}),
        userMessageId,
      },
    );
  } catch (e) {
    await deps.finishTurn(
      input.sessionId,
      "error",
      (e as { errorCode?: string })?.errorCode,
    );
    throw e;
  }
  deps.logger.app("session", "info", "prompt accepted", {
    sessionId: input.sessionId,
    turnId: result.turnId,
    data: {
      providerId: input.launch.providerId,
      modelId: input.launch.modelId,
    },
  });
  return { accepted: result.accepted, turnId, userMessageId };
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { role?: string; content?: unknown; parentToolCallId?: unknown }
      | undefined;
    if (!message || message.role !== "assistant") continue;
    // Delegate rows belong to a Task call, not to this turn's reply.
    if (message.parentToolCallId) continue;
    return typeof message.content === "string" ? message.content : "";
  }
  return "";
}

export interface HeadlessAgentDriver {
  start(request: HeadlessRunRequest): Promise<HeadlessRunHandle>;
}

export function createHeadlessAgentDriver(
  deps: HeadlessDriverDeps,
): HeadlessAgentDriver {
  return {
    async start(request: HeadlessRunRequest): Promise<HeadlessRunHandle> {
      // Validate the request shape before touching the backend so callers get
      // deterministic argument errors regardless of process state.
      const prompt = String(request.prompt ?? "").trim();
      if (!prompt) {
        throw httpError("prompt required", INVALID_ARGUMENT);
      }
      if (request.mode && request.mode !== "agent") {
        throw httpError(
          "headless runs only support agent mode",
          CONTRACT_MODE_ERROR,
        );
      }
      const host = deps.getHost();
      const sidecar = deps.getSidecar();
      if (!host || !sidecar) throw new Error("backend unavailable");

      // Resolve (or create) the session that will own the turn.
      let sessionId = String(request.sessionId ?? "").trim();
      let session: Record<string, unknown> | undefined;
      if (sessionId) {
        session = (
          await host.call<{ session?: Record<string, unknown> }>("session.get", {
            id: sessionId,
          })
        ).session;
        if (!session) {
          throw httpError("Session not found", NOT_FOUND);
        }
      } else {
        const hints = request.newSession ?? {};
        const created = await host.call<{
          session?: Record<string, unknown> & { id?: string };
        }>("session.create", {
          title: String(hints.title ?? "").trim() || "Headless task",
          mode: "agent",
          ...(hints.providerId ? { providerId: hints.providerId } : {}),
          ...(hints.modelId ? { modelId: hints.modelId } : {}),
          ...(hints.projectPath ? { projectPath: hints.projectPath } : {}),
          ...(hints.thinkingLevel ? { thinkingLevel: hints.thinkingLevel } : {}),
        });
        session = created.session;
        sessionId = String(session?.id ?? "").trim();
        if (!sessionId) {
          throw new Error("session.create returned no session");
        }
        deps.logger.app("session", "info", "headless session created", {
          sessionId,
        });
      }
      if (deps.activeTurns.has(sessionId)) {
        throw httpError("Session already has an active turn", AGENT_BUSY);
      }

      const settings = await host.call("settings.get");
      const launch = await deps.resolveLaunch(sessionId, session, settings, {
        mode: "agent",
        ...(request.providerId ? { providerId: request.providerId } : {}),
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(request.thinkingLevel
          ? { thinkingLevel: request.thinkingLevel }
          : {}),
        ...(request.personaPrompt ? { personaPrompt: request.personaPrompt } : {}),
      });
      sidecar.setProjectInstructionRoot(sessionId, launch.projectPath);

      const userMessageId = `headless-${crypto.randomUUID()}`;
      const userMessage = {
        id: userMessageId,
        role: "user" as const,
        content: prompt,
        createdAt: new Date().toISOString(),
        status: "complete" as const,
      };
      const { turnId } = await beginDurableTurnAndPrompt(deps, {
        sessionId,
        launch,
        modelContent: prompt,
        userMessage,
        echoToRenderer: true,
      });

      const timeoutMs =
        request.timeoutMs ?? deps.defaultTimeoutMs ?? 30 * 60 * 1000;
      const completion = (async (): Promise<HeadlessRunResult> => {
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            deps.waitForTurnSettlement(sessionId, turnId),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("headless run timed out"));
              }, timeoutMs);
            }),
          ]);
        } catch {
          // Timeout: abort through the sidecar so the event stream records the
          // aborted rows, then give the normal settlement a bounded chance.
          deps.logger.app("session", "warn", "headless run timed out", {
            sessionId,
            data: { turnId, timeoutMs },
          });
          await sidecar
            .call("agent.abort", { sessionId })
            .catch(() => undefined);
          await Promise.race([
            deps.waitForTurnSettlement(sessionId, turnId),
            new Promise((resolve) =>
              setTimeout(resolve, deps.abortGraceMs ?? ABORT_GRACE_MS),
            ),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        let settled = deps.consumeTurnSettlement(sessionId, turnId);
        if (!settled) {
          // Settlement raced ahead of the waiter (or the abort grace ran out):
          // close the durable turn here so nothing stays 'running' in the DB.
          settled = { status: timedOut ? "aborted" : "error", errorCode: timedOut ? HEADLESS_TIMEOUT : "TURN_SETTLEMENT_LOST" };
          await deps.finishTurn(sessionId, settled.status, settled.errorCode);
        }
        const detail = await host
          .call<{ session?: { messages?: unknown } }>("session.get", {
            id: sessionId,
          })
          .catch(() => undefined);
        const result: HeadlessRunResult = {
          sessionId,
          turnId,
          status: settled.status,
          ...(settled.errorCode ? { errorCode: settled.errorCode } : {}),
          ...(settled.usage ? { usage: settled.usage } : {}),
          finalText: lastAssistantText(detail?.session?.messages),
        };
        deps.logger.app("session", "info", "headless run settled", {
          sessionId,
          data: { turnId, status: result.status },
        });
        return result;
      })();

      return { sessionId, turnId, completion };
    },
  };
}
