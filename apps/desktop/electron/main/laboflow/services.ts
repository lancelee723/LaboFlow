/**
 * LaboFlow fork services (Phase 6 T6.0.1) — the org/expert/kb/channel/space
 * capability set re-mounted onto the upstream factory orchestration.
 *
 * Phase 5 built these as inline blocks in the old monolithic index.ts; the
 * v0.15.10 merge replaced that file with the upstream factory composition, so
 * everything fork-owned lives here now. `index.ts` calls this factory once,
 * after the session launch runtime exists, and hands the returned
 * `registerIpc` a pair of handler adapters. Upstream surfaces are touched only
 * through the injected dependencies (R5-10).
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import {
  IPC,
  type KbServerDelivery,
  type MessageUsage,
  type ThinkingLevel,
  OAUTH_AUTH_KIND,
} from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "@pi-desktop/agent-runtime";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { ClawhubClient } from "../clawhub";
import { createHeadlessAgentDriver, beginDurableTurnAndPrompt } from "../headless-agent-driver";
import { ForegroundSessionRegistry } from "../expert-foreground";
import { ExpertService } from "../expert-service";
import { TeamRunner } from "../team-runner";
import { KbService } from "../kb-service";
import { OrgService } from "../org-service";
import { OrgWorkspaceHub } from "../org-workspaces";
import { createChannelRegistryHost } from "../channels/registry";
import { createSpaceClient, createSpaceIpcHost } from "../space-client";
import { createChannelCredentialStore } from "../channels/credential-store";
import { createFeishuAdapterFactory } from "../channels/feishu";
import { createWecomAdapterFactory } from "../channels/wecom";
import { createWechatMpAdapterFactory } from "../channels/wechat-mp";

type HostLike = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
} | null;


export type LaboflowServicesDeps = {
  getHost: () => HostLike;
  getSidecar: () => any;
  logger: { app(scope: string, level: string, message: string, data?: unknown): void };
  sendToRenderer: (channel: string, payload: unknown) => void;
  dataDir: string;
  vendorOAuth: {
    resolveAuth(providerId: string): Promise<unknown>;
  };
  /** From the session launch runtime (upstream `createSessionLaunchRuntime`). */
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: unknown,
    settings: unknown,
    overrides?: Record<string, any>,
  ) => Promise<any>;
  /** From the plan runtime (upstream `createPlanRuntime`), for driver fallbacks. */
  finishTurn: (
    sessionId: string,
    status: "completed" | "aborted" | "error",
    errorCode?: string,
    options?: { turnId: string },
  ) => Promise<unknown>;
  /** Shared turn state owned by index.ts (single source of truth). */
  activeTurns: Map<string, any>;
  activeTurnUsages: Map<string, MessageUsage>;
  /** Plugin runtime (upstream factory) — read-only plugin data access. */
  plugins: {
    readPluginDataJson(pluginId: string, file: string): unknown | null;
  };
  /** From `laboflow/settlement.ts` — fed by the plan runtime's settle hook. */
  settlement: {
    waitForTurnSettlement(sessionId: string, turnId: string): Promise<void>;
    consumeTurnSettlement(
      sessionId: string,
      turnId: string,
    ):
      | { status: "completed" | "aborted" | "error"; errorCode?: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }
      | undefined;
    lastWaitedTurnId(sessionId: string): string | undefined;
  };
  /** Main-window sender assertion from index.ts (window identity check). */
  assertMainWindowSender: (event: { sender: { id: number } }) => void;
};

type IpcHandler = (channel: string, fn: (...args: any[]) => Promise<any>) => void;
type IpcHandlerWithEvent = (
  channel: string,
  fn: (event: { sender: { id: number } }, ...args: any[]) => Promise<any>,
) => void;

export function createLaboflowServices(deps: LaboflowServicesDeps) {
  const { getHost, getSidecar, logger, sendToRenderer, dataDir } = deps;
  const host = () => getHost();

  // HeadlessAgentDriver (T53.1): main-process agent execution shared by
  // scheduled tasks, IM-triggered prompts (module 04) and background expert
  // dispatch (module 01). Same durable-turn lifecycle as the interactive path.
  const headlessAgentDriver = createHeadlessAgentDriver({
    getHost,
    getSidecar,
    resolveLaunch: deps.resolveAgentRuntimeLaunch as any,
    // Driver fallbacks close the turn the driver last waited on; the plan
    // runtime owns the real lifecycle, this only covers lost settlements.
    finishTurn: async (sessionId: string, status: any, errorCode?: string) => {
      const turnId = deps.settlement.lastWaitedTurnId(sessionId) ?? "";
      return deps.finishTurn(sessionId, status, errorCode, { turnId });
    },
    waitForTurnSettlement: deps.settlement.waitForTurnSettlement,
    consumeTurnSettlement: deps.settlement.consumeTurnSettlement,
    activeTurns: deps.activeTurns,
    activeTurnUsages: deps.activeTurnUsages,
    sendToRenderer,
    agentMessageEvent: IPC.event.agentMessage,
    logger,
  });

  async function postSessionCard(
    sessionId: string,
    message: {
      id: string;
      role: "assistant";
      content: string;
      createdAt: string;
      status: "complete";
      kind?: string;
    },
  ): Promise<void> {
    const h = host();
    if (!h) throw new Error("backend unavailable");
    await h.call("session.appendMessage", { sessionId, message });
    sendToRenderer(IPC.event.agentMessage, {
      sessionId,
      ts: Date.now(),
      event: { type: "message_start", message },
    } satisfies AgentEventEnvelope);
    sendToRenderer(IPC.event.agentMessage, {
      sessionId,
      ts: Date.now(),
      event: { type: "message_end", message },
    } satisfies AgentEventEnvelope);
  }

  // Expert center (module 01): experts are independent agents. Foreground
  // polish: dispatch creates a REAL session and streams into it; the persona
  // binding lives in the foreground registry so later turns keep the persona.
  const expertForegroundRegistry = new ForegroundSessionRegistry(dataDir);
  const expertService = new ExpertService({
    getHost,
    getLogger: () => logger,
    getDriver: () => headlessAgentDriver,
    broadcast: (event) => sendToRenderer(IPC.event.expertTeamRun, event),
    postSessionCard,
    foregroundRegistry: expertForegroundRegistry,
  });

  async function getOneShotProvider(): Promise<{
    provider: RuntimeProviderConfig;
    thinkingLevel: ThinkingLevel;
  } | null> {
    const h = host();
    const sidecar = getSidecar();
    if (!h || !sidecar) return null;
    try {
      const settings = await h.call<any>("settings.get");
      const launch = await deps.resolveAgentRuntimeLaunch(
        `team-leader:${randomUUID()}`,
        {},
        settings,
        { mode: "agent" },
      );
      const provider = {
        ...launch.sidecarParams.provider,
        ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
          ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(launch.providerId) }
          : {}),
      } as RuntimeProviderConfig;
      return {
        provider,
        thinkingLevel: launch.sidecarParams.thinkingLevel as ThinkingLevel,
      };
    } catch {
      return null;
    }
  }

  const kbService = new KbService({
    getHost,
    getLogger: () => logger,
  });

  // Module 04: IM channels — registry, adapters, and channel IPC. Messages
  // that pass the allowlist dispatch through the headless driver and the
  // result is sent back over the channel adapter.
  let spaceHost: ReturnType<typeof createSpaceIpcHost> | undefined;
  /** Org-session accessors for channel adapters that need them (wechat_mp). */
  const orgChannelContext: {
    tokenProvider?: () => Promise<string>;
    serverUrl?: () => string | undefined;
  } = {};
  const channelHost = createChannelRegistryHost({
    getLogger: () => logger,
    getDriver: () => headlessAgentDriver,
    adapters: {
      feishu: createFeishuAdapterFactory(),
      wecom: createWecomAdapterFactory(),
      wechat_mp: createWechatMpAdapterFactory({
        tokenProvider: async () => {
          const provider = orgChannelContext.tokenProvider;
          if (!provider) {
            throw new Error("ORG_SESSION_REQUIRED: 公众号通道需要先登录组织");
          }
          return provider();
        },
        serverUrl: () => orgChannelContext.serverUrl?.(),
      }),
    },
    credentialStore: createChannelCredentialStore(),
    broadcast: (event) => sendToRenderer(IPC.event.channelState, event),
  });

  const teamRunner = new TeamRunner({
    getLogger: () => logger,
    getDriver: () => headlessAgentDriver,
    getOneShotProvider,
    createSession: async (input) => {
      const h = host();
      if (!h) throw new Error("host unavailable");
      const created = await h.call<{ session?: { id?: string } }>("session.create", {
        title: input.title,
        mode: "agent",
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      });
      const id = String(created.session?.id ?? "").trim();
      if (!id) throw new Error("session.create returned no session");
      return { id };
    },
    foregroundRegistry: expertForegroundRegistry,
    resolveTeam: async (teamId) => {
      const h = host();
      const teams = await expertService.listTeams();
      const team = teams.find((item) => item.id === teamId || item.name === teamId);
      if (!team) return null;
      const read = h
        ? await h
            .call<{ team: Record<string, unknown> | null; body: string | null }>(
              "expertTeams.read",
              { id: team.id },
            )
            .catch(() => ({ team: null, body: null }))
        : { team: null, body: null };
      return {
        name: team.name,
        description: team.description,
        members: team.members,
        leaderStyle: team.leaderStyle,
        integration: team.integration,
        pipeline: (read.team?.pipeline as string | undefined) ?? undefined,
        stageExperts: (read.team?.stageExperts as string | undefined) ?? undefined,
        goal: (read.team?.goal as string | undefined) ?? undefined,
        rounds: (read.team?.rounds as number | undefined) ?? undefined,
        maxRounds: (read.team?.maxRounds as number | undefined) ?? undefined,
        budgetTokens: team.budgetTokens,
        body: read.body ?? "",
      };
    },
    resolvePersona: (id) => expertService.resolvePersona(id),
    broadcast: (event) => sendToRenderer(IPC.event.expertTeamRun, event),
    postSessionCard,
    getProjectPath: async (sessionId) => {
      const h = host();
      if (!sessionId || !h) return undefined;
      const detail = await h
        .call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId })
        .catch(() => undefined);
      return detail?.session?.projectPath;
    },
  });

  // Org session (PRD 4.1.12): login/logout/status against the LaboFlow
  // Server. Tokens live in the host secret store; the renderer only sees the
  // mapped OrgStatus profile.
  const orgService = new OrgService({
    call: async <T,>(method: string, params?: unknown) => {
      const h = host();
      if (!h) throw new Error("host unavailable");
      return (await h.call(method, params)) as T;
    },
  });
  orgChannelContext.tokenProvider = async () => {
    const token = await orgService.getAccessToken();
    if (!token) throw new Error("ORG_SESSION_REQUIRED: 公众号通道需要先登录组织");
    return token;
  };
  orgChannelContext.serverUrl = () => orgService.getServerUrl();

  // Phase 3: register the "org-provided" provider from the bootstrap payload
  // (gateway URL + freshly issued virtual key + assigned channel models) so
  // the model picker lists org channels alongside personal ones.
  const syncOrgProvider = async (): Promise<void> => {
    const h = host();
    const bootstrap = orgService.getBootstrap();
    if (!bootstrap) return;
    const gateway = bootstrap.gateway;
    if (!h || !gateway?.url || !gateway.virtualKey) return;
    const modelIds = [
      ...new Set(
        (bootstrap.orgChannels ?? []).flatMap((channel: any) =>
          Array.isArray(channel.models) ? channel.models.map(String) : [],
        ),
      ),
    ];
    if (!modelIds.length) return;
    const thinkingLevels: ThinkingLevel[] = ["off", "low", "medium", "high"];
    const models = modelIds.map((id) => ({
      id,
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels,
      defaultThinkingLevel: null as ThinkingLevel | null,
    }));
    const input = {
      name: "LaboFlow 组织渠道",
      vendorKey: "org-gateway",
      type: "openai_compatible" as const,
      protocol: "openai_compatible",
      baseUrl: `${gateway.url.replace(/\/+$/, "")}/openai/v1`,
      authKind: "api_key_and_base_url",
      models,
      defaultModelId: models[0]?.id,
      secretValue: gateway.virtualKey,
    };
    const list = await h.call<{
      providers?: Array<{ id?: string; vendorKey?: string }>;
    }>("providers.list", { includeDisabled: true });
    const existing = (list.providers ?? []).find(
      (provider) => provider.vendorKey === "org-gateway",
    );
    if (existing?.id) {
      await h.call("providers.update", { id: existing.id, ...input });
    } else {
      await h.call("providers.create", input);
    }
  };

  const removeOrgProvider = async (): Promise<void> => {
    const h = host();
    if (!h) return;
    const list = await h.call<{
      providers?: Array<{ id?: string; vendorKey?: string }>;
    }>("providers.list", { includeDisabled: true });
    const existing = (list.providers ?? []).find(
      (provider) => provider.vendorKey === "org-gateway",
    );
    if (existing?.id) await h.call("providers.delete", { id: existing.id });
  };

  /** Org expert/team packs ride the bootstrap cache (T51.8, in-memory). */
  function applyOrgExpertPacks(): void {
    const bootstrap = orgService.getBootstrap() as {
      expertPacks?: Array<{
        kind: "expert" | "team";
        name: string;
        payload: Record<string, unknown>;
        version: number;
      }>;
    } | null;
    expertService.setOrgPacks(bootstrap?.expertPacks ?? []);
  }

  /** Org-provided knowledge-base entries land in the MCP registry (T55.6). */
  async function applyOrgKbDelivery(): Promise<void> {
    const bootstrap = orgService.getBootstrap() as {
      org?: { id?: string };
      kbServers?: KbServerDelivery[];
    } | null;
    const orgId = String(bootstrap?.org?.id ?? "").trim();
    const items = bootstrap?.kbServers ?? [];
    if (!orgId || items.length === 0) return;
    const result = await kbService.applyOrgDelivery(orgId, items);
    logger.app("kb", "info", "org kb delivery applied", {
      data: { applied: result.applied, removed: result.removed },
    });
  }

  // Phase 4 shared-workspace client (declared before the org handlers so
  // sign-out can drop live streams).
  const orgHub = new OrgWorkspaceHub({
    getJson: (path) => orgService.getOrgJson(path),
    postJson: (path, body) => orgService.postOrgJson(path, body),
    getToken: () => orgService.getAccessToken(),
    getUserId: async () => orgService.getMe()?.userId,
    getServerUrl: async () => orgService.getServerUrl(),
    emit: (frame) => sendToRenderer(IPC.event.orgWsFrame, frame),
  });

  // Module 02: Team Spaces — REST client + per-space event poll loop.
  // PATCH/PUT/DELETE mirror postOrgJson but keep the server's machine-readable
  // {code,message} body so EVERSION/EANCHOR reach the renderer as readable toasts.
  async function spaceOrgRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await orgService.getAccessToken();
    const serverUrl = orgService.getServerUrl();
    if (!token || !serverUrl) throw new Error("ORG_NOT_CONNECTED");
    const response = await fetch(`${serverUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) throw new Error("ORG_EXPIRED");
    if (!response.ok) {
      const errBody = (await response.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      throw Object.assign(
        new Error(errBody.message ?? `ORG_API_FAILED: HTTP ${response.status}`),
        { code: errBody.code, status: response.status },
      );
    }
    return response.json().catch(() => ({}));
  }
  spaceHost = createSpaceIpcHost({
    client: createSpaceClient({
      getJson: (path) => orgService.getOrgJson(path),
      postJson: (path, body) => orgService.postOrgJson(path, body),
      patchJson: (path, body) => spaceOrgRequest("PATCH", path, body),
      putJson: (path, body) => spaceOrgRequest("PUT", path, body),
      deleteJson: (path) => spaceOrgRequest("DELETE", path),
    }),
    emit: (frame) => sendToRenderer(IPC.event.spaceEvent, frame),
    warn: (context, message) =>
      logger.app("session", "warn", "space events poll", {
        data: `${context}: ${message}`,
      }),
  });

  function applyOrgDeliveryOnConnect(): void {
    applyOrgExpertPacks();
    void applyOrgKbDelivery().catch((error) =>
      logger.app("kb", "warn", "org kb delivery failed", { data: String(error) }),
    );
  }

  /**
   * All fork-owned IPC channels. Registered with plain `ipcMain.handle`
   * adapters provided by index.ts so error wrapping matches the host's own.
   */
  function registerIpc(handle: IpcHandler, handleWithEvent: IpcHandlerWithEvent): void {
    const requireHost = () => {
      const h = host();
      if (!h) throw new Error("host unavailable");
      return h;
    };

    // Module 04: channel accounts + connect/test lifecycle IPC (registry-owned).
    channelHost.registerIpc(handle);
    // Module 02: team-space tree/docs/comments/revisions/events IPC.
    spaceHost?.registerIpc(handle);

    handleWithEvent(
      IPC.invoke.composerAttachSession,
      async (
        event,
        input: { sessionId?: unknown; targetSessionId?: unknown } = {},
      ) => {
        const { attachSessionTranscript } = await import("../session-attach");
        deps.assertMainWindowSender(event);
        const h = requireHost();
        const sessionId =
          typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        const targetSessionId =
          typeof input.targetSessionId === "string"
            ? input.targetSessionId.trim()
            : "";
        if (!sessionId || !targetSessionId || targetSessionId === sessionId) {
          throw Object.assign(new Error("invalid session attach input"), {
            errorCode: "INVALID_ARGUMENT",
          });
        }
        const detail = (await h.call("session.get", {
          id: sessionId,
        })) as {
          session?: {
            title?: string;
            messages?: Array<{ role?: string; content?: string; createdAt?: string }>;
          } | null;
        };
        const source = detail.session;
        if (!source) {
          throw Object.assign(new Error("session not found"), {
            errorCode: "NOT_FOUND",
          });
        }
        const saved = await attachSessionTranscript(
          dataDir,
          targetSessionId,
          source.title || "",
          source.messages ?? [],
        );
        return { files: [saved] };
      },
    );

    // Expert center (module 01)
    handle(IPC.invoke.expertList, async () => expertService.list());
    handle(
      IPC.invoke.expertGet,
      async (req: { id: string }) => expertService.get(String(req?.id ?? "").trim()),
    );
    handle(IPC.invoke.expertSave, async (input: Record<string, unknown>) =>
      expertService.save(input ?? {}),
    );
    handle(IPC.invoke.expertDelete, async (req: { id: string }) =>
      expertService.delete(String(req?.id ?? "").trim()),
    );
    handle(
      IPC.invoke.expertToggle,
      async (req: { id: string; enabled: boolean }) =>
        expertService.toggle(String(req?.id ?? "").trim(), req?.enabled === true),
    );
    handle(
      IPC.invoke.expertInvoke,
      async (req: { sessionId?: string; expertId: string; task: string }) =>
        expertService.invoke({
          sessionId: req?.sessionId,
          expertId: String(req?.expertId ?? "").trim(),
          task: String(req?.task ?? "").trim(),
        }),
    );
    handle(IPC.invoke.expertTeamsList, async () => expertService.listTeams());
    handle(
      IPC.invoke.expertTeamGet,
      async (req: { id: string }) => {
        const h = requireHost();
        return h.call("expertTeams.read", { id: String(req?.id ?? "").trim() });
      },
    );
    handle(IPC.invoke.expertTeamSave, async (input: Record<string, unknown>) => {
      const h = requireHost();
      const name = String(input?.name ?? "").trim();
      if (!name) throw new Error("EXPERT_INVALID: name is required");
      const payload = {
        name,
        description: input.description,
        members: input.members,
        leaderStyle: input.leaderStyle,
        integration: input.integration,
        budgetTokens: input.budgetTokens,
        body: input.body,
      };
      const existing = await h.call<{ teams: Array<{ id: string; name: string }> }>(
        "expertTeams.list",
      );
      const isUpdate = existing.teams.some((team) => team.name === name);
      return isUpdate
        ? h.call("expertTeams.update", { id: name, team: payload })
        : h.call("expertTeams.create", { team: payload });
    });
    handle(IPC.invoke.expertTeamDelete, async (req: { id: string }) => {
      const h = requireHost();
      return h.call("expertTeams.remove", { id: String(req?.id ?? "").trim() });
    });
    handle(
      IPC.invoke.expertTeamInvoke,
      async (req: { sessionId?: string; teamId: string; task: string }) =>
        teamRunner.invoke({
          sessionId: req?.sessionId,
          teamId: String(req?.teamId ?? "").trim(),
          task: String(req?.task ?? "").trim(),
        }),
    );
    handle(
      IPC.invoke.expertTeamRetryMember,
      async (req: { runId: string; index: number }) =>
        teamRunner.retryMember({
          runId: String(req?.runId ?? "").trim(),
          index: Number(req?.index ?? -1),
        }),
    );

    // Knowledge base (module 05)
    handle(IPC.invoke.kbListUrls, async () => kbService.listUrls());
    handle(
      IPC.invoke.kbSaveUrl,
      async (req: { name: string; url: string }) => kbService.saveUrl(req ?? {}),
    );
    handle(IPC.invoke.kbDeleteUrl, async (req: { id: string }) =>
      kbService.deleteUrl(String(req?.id ?? "").trim()),
    );
    handle(
      IPC.invoke.kbApplyOrgDelivery,
      async (req: { orgId: string; items: KbServerDelivery[] }) =>
        kbService.applyOrgDelivery(String(req?.orgId ?? "").trim(), req?.items ?? []),
    );
    handle(IPC.invoke.kbDisableOrgServers, async () => kbService.disableOrgServers());

    // Organization session + Phase 3 provider + Phase 4 workspaces
    handle(
      IPC.invoke.orgLogin,
      async (input: { serverUrl: string; username: string; password: string }) => {
        const status = await orgService.login(input);
        if (status.state === "connected") {
          await syncOrgProvider();
          applyOrgDeliveryOnConnect();
        }
        return status;
      },
    );
    handle(IPC.invoke.orgStatus, async () => {
      const status = await orgService.status();
      if (status.state === "connected") {
        await syncOrgProvider();
        applyOrgDeliveryOnConnect();
      }
      return status;
    });
    handle(IPC.invoke.orgChangePassword, (input: { currentPassword: string; newPassword: string }) =>
      orgService.changePassword(input),
    );
    handle(IPC.invoke.orgLogout, async () => {
      const status = await orgService.logout();
      // Signing out of the current org: the provider follows whatever org is
      // current now (and is removed only when no session remains). Live WS
      // streams die with the session.
      if (status.state === "connected") await syncOrgProvider();
      else {
        await removeOrgProvider();
        orgHub.disconnectAll();
        expertService.setOrgPacks([]);
        await kbService.disableOrgServers().catch(() => undefined);
      }
      return status;
    });
    handle(IPC.invoke.orgSetCurrent, async (input: { key: string }) => {
      const status = await orgService.setCurrent(String(input?.key ?? ""));
      if (status.state === "connected") await syncOrgProvider();
      return status;
    });
    handle(IPC.invoke.orgQuotaRemaining, () => orgService.quotaRemaining());
    handle(IPC.invoke.orgRemoveSession, (input: { key: string }) =>
      orgService.removeSession(String(input?.key ?? "")),
    );
    handle(
      IPC.invoke.orgSetSessionEnabled,
      (input: { key: string; enabled: boolean }) =>
        orgService.setSessionEnabled(String(input?.key ?? ""), Boolean(input.enabled)),
    );
    handle(IPC.invoke.orgWsSessions, (input: { wid: string }) =>
      orgService.getOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions`,
      ),
    );
    handle(
      IPC.invoke.orgWsCreateSession,
      (input: { wid: string; title: string }) =>
        orgService.postOrgJson(
          `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions`,
          { title: String(input?.title ?? "共享会话") },
        ),
    );
    handle(
      IPC.invoke.orgWsEntries,
      (input: { wid: string; sid: string; since?: number }) =>
        orgService.getOrgJson(
          `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions/${encodeURIComponent(String(input?.sid ?? ""))}/entries?since=${Number(input?.since ?? -1)}`,
        ),
    );
    handle(IPC.invoke.orgWsConnect, async (input: { wid: string; sid: string }) => {
      await orgHub.connect(String(input?.wid ?? ""), String(input?.sid ?? ""));
      return { ok: true };
    });
    handle(IPC.invoke.orgWsDisconnect, async (input: { sid: string }) => {
      orgHub.disconnect(String(input?.sid ?? ""));
      return { ok: true };
    });
    handle(IPC.invoke.orgWsLock, (input: { wid: string; sid: string }) =>
      orgService.postOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions/${encodeURIComponent(String(input?.sid ?? ""))}/lock`,
        {},
      ),
    );
    handle(IPC.invoke.orgWsRelease, async (input: { wid: string; sid: string }) =>
      orgService.postOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions/${encodeURIComponent(String(input?.sid ?? ""))}/release`,
        {},
      ),
    );
    handle(
      IPC.invoke.orgWsSay,
      async (input: { wid: string; sid: string; text: string }) =>
        orgHub.say(String(input?.wid ?? ""), String(input?.sid ?? ""), String(input?.text ?? "")),
    );
    handle(IPC.invoke.orgWsDeliverables, (input: { wid: string }) =>
      orgService.getOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/deliverables`,
      ),
    );
    handle(
      IPC.invoke.orgWsDeliverableUpload,
      (input: { wid: string; path: string; title?: string; contentBase64: string; sessionId?: string }) =>
        orgService.postOrgJson(
          `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/deliverables`,
          {
            path: input?.path,
            title: input?.title ?? input?.path,
            contentBase64: input?.contentBase64,
            source: "upload",
            sessionId: input?.sessionId,
          },
        ),
    );
    handle(
      IPC.invoke.orgWsDeliverableDownload,
      (input: { did: string; version?: number }) =>
        orgService.getOrgJson(
          `/deliverables/${encodeURIComponent(String(input?.did ?? ""))}/download${input?.version ? `?version=${input.version}` : ""}`,
        ),
    );

    // Pull requests of the active workspace (fork page kept through the merge)
    handle(IPC.invoke.pullsList, async () => {
      const h = requireHost();
      const res = (await h.call("workspace.get")) as {
        workspace: { path: string; name: string } | null;
      };
      const cwd = res.workspace?.path;
      if (!cwd) {
        return { pulls: [], error: "NO_WORKSPACE" as const };
      }
      const { spawn } = await import("node:child_process");
      const run = (cmd: string, args: string[]) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(cmd, args, { cwd, env: process.env });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += String(d)));
          child.stderr.on("data", (d) => (stderr += String(d)));
          child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
          child.on("error", (err) =>
            resolve({ code: 1, stdout: "", stderr: String(err) }),
          );
        });
      const result = await run("gh", [
        "pr",
        "list",
        "--limit",
        "30",
        "--json",
        "number,title,url,author,headRefName,baseRefName,updatedAt,isDraft",
      ]);
      if (result.code !== 0) {
        return {
          pulls: [],
          error: result.stderr.trim() || result.stdout.trim() || "GH_FAILED",
        };
      }
      try {
        const pulls = JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>;
        return {
          pulls: pulls.map((p) => ({
            number: Number(p.number),
            title: String(p.title || ""),
            url: String(p.url || ""),
            author:
              typeof p.author === "object" && p.author
                ? String((p.author as any).login || "")
                : undefined,
            headRefName: p.headRefName ? String(p.headRefName) : undefined,
            baseRefName: p.baseRefName ? String(p.baseRefName) : undefined,
            updatedAt: p.updatedAt ? String(p.updatedAt) : undefined,
            isDraft: Boolean(p.isDraft),
          })),
        };
      } catch (e) {
        return { pulls: [], error: e instanceof Error ? e.message : String(e) };
      }
    });

    // Clawhub skill market: zip-shaped skill packages land in ~/.agents/skills
    handle(
      IPC.invoke.skillMarketInstall,
      async (payload: { slug: string; ownerHandle?: string }) => {
        const slug = String(payload?.slug ?? "").trim();
        if (!slug) throw new Error("SKILL_MARKET_SLUG_REQUIRED");
        const ownerHandle = payload?.ownerHandle
          ? String(payload.ownerHandle).trim()
          : undefined;
        const client = new ClawhubClient();
        const pkg = await client.download(slug, ownerHandle);
        if (!pkg) throw new Error("SKILL_MARKET_DOWNLOAD_FAILED");
        const workDir = await mkdtemp(join(tmpdir(), "laboflow-skill-"));
        try {
          const zipPath = join(workDir, "skill.zip");
          const extractDir = join(workDir, "extracted");
          await writeFile(zipPath, pkg.zip);
          new AdmZip(zipPath).extractAllTo(extractDir, true);
          const entries = await readdir(extractDir, { withFileTypes: true });
          const hasSkillMd = (
            list: Array<{ isFile(): boolean; name: string; isDirectory(): boolean }>,
          ) =>
            list.some(
              (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md",
            );
          let skillDir: string | null = null;
          if (hasSkillMd(entries)) {
            skillDir = extractDir;
          } else {
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const innerDir = join(extractDir, entry.name);
              if (hasSkillMd(await readdir(innerDir, { withFileTypes: true }))) {
                skillDir = innerDir;
                break;
              }
            }
          }
          if (!skillDir) throw new Error("SKILL_MARKET_INVALID_PACKAGE");
          const skillsRoot = join(homedir(), ".agents", "skills");
          const destination = join(skillsRoot, slug.replace(/[^\w.-]+/g, "-"));
          await mkdir(skillsRoot, { recursive: true });
          await rm(destination, { recursive: true, force: true });
          await cp(skillDir, destination, { recursive: true });
          sendToRenderer(IPC.event.pluginChanged, { reason: "skill" });
          return { ok: true, destination };
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      },
    );

    // The usage stats page reads the Token Insights plugin's published facts.
    handle(IPC.invoke.statsGetTokenInsights, async () => {
      const data = deps.plugins.readPluginDataJson(
        "pi.token-insights",
        "settings.json",
      ) as { usageFacts?: Record<string, unknown> } | null;
      const facts = data?.usageFacts;
      if (!facts || typeof facts !== "object") return { available: false };
      return {
        available: true,
        generatedAt:
          typeof facts.generatedAt === "number" ? facts.generatedAt : undefined,
        columns: Array.isArray(facts.columns) ? facts.columns : [],
        days: Array.isArray(facts.days) ? facts.days : [],
        models: Array.isArray(facts.models) ? facts.models : [],
        sources: Array.isArray(facts.sources) ? facts.sources : [],
        buckets: Array.isArray(facts.buckets) ? facts.buckets : [],
      };
    });
  }

  return {
    services: {
      headlessAgentDriver,
      expertService,
      expertForegroundRegistry,
      teamRunner,
      kbService,
      orgService,
      orgHub,
      channelHost,
      getSpaceHost: () => spaceHost,
    },
    registerIpc,
  };
}

export type LaboflowServices = ReturnType<typeof createLaboflowServices>;
