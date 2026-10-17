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
  ChannelAccount,
  err,
  ok,
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
import { createWebhookServer } from "../assistant/im-server";
import { ForegroundSessionRegistry } from "../expert-foreground";
import { ExpertService } from "../expert-service";
import { TeamRunner } from "../team-runner";
import { startExpertChain } from "./expert-chain";
import { kbUsageHistory, type KbUsageLedger } from "./kb-usage";
import { KbService } from "../kb-service";
import { OrgService } from "../org-service";
import { OrgWorkspaceHub } from "../org-workspaces";
import { createChannelRegistryHost } from "../channels/registry";
import { completeOneShot } from "@pi-desktop/agent-runtime";
import type { RevisionSuggestion } from "@pi-desktop/shared";
import { createSpaceClient, createSpaceIpcHost } from "../space-client";
import { createYjsBridge } from "./yjs-bridge";
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
    isOrgActive: () => Boolean(orgService.getBootstrap()),
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

  let assistantSessionId: string | null = null;
  async function ensureAssistantSessionCached(h: NonNullable<ReturnType<typeof host>>) {
    if (assistantSessionId) {
      try {
        const detail = await h.call<{ session?: { id?: string } }>("session.get", {
          id: assistantSessionId,
        });
        if (detail.session?.id) return { sessionId: assistantSessionId, created: false };
      } catch {
        // stale id → fall through and re-locate
      }
      assistantSessionId = null;
    }
    const { ensureAssistantSession } = await import("../assistant/im-assistant");
    const ensured = await ensureAssistantSession(h);
    assistantSessionId = ensured.sessionId;
    return ensured;
  }

  /** FR-TC-10: LLM-backed review-by-comments production (main-side seam). */
  async function reviewByComments(spaceId: string, nodeId: string): Promise<RevisionSuggestion[]> {
    if (!spaceClient) throw new Error("space client unavailable");
    const { buildReviewUserPrompt, parseReviewSuggestions, REVIEW_SYSTEM_PROMPT } =
      await import("./revision-review");
    const comments = (await spaceClient.listComments(spaceId, nodeId)).filter(
      (comment) => comment.status === "open",
    );
    if (!comments.length) return [];
    const doc = await spaceClient.getDoc(spaceId, nodeId);
    const oneShot = await getOneShotProvider();
    if (!oneShot) {
      throw Object.assign(new Error("model not configured"), {
        errorCode: "MODEL_NOT_CONFIGURED",
      });
    }
    const result = await completeOneShot(
      oneShot.provider,
      {
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: buildReviewUserPrompt(
              doc.content ?? "",
              comments.map((comment) => ({
                id: comment.id,
                authorId: comment.authorId,
                body: comment.body,
                status: comment.status,
                anchor: (comment as { anchor?: { textPrefix?: string } }).anchor ?? null,
              })),
            ),
            timestamp: Date.now(),
          },
        ],
      },
      oneShot.thinkingLevel,
      { sessionId: `space-review:${nodeId}` },
    );
    const drafts = parseReviewSuggestions(result.text ?? "");
    const created: RevisionSuggestion[] = [];
    for (const draft of drafts) {
      created.push(
        await spaceClient.createRevision(spaceId, nodeId, {
          ...draft,
          producedBy: "agent" as const,
        }),
      );
    }
    return created;
  }

  /** FR-TC-12: in-place AI rewrite of one selection (one-shot, no doc write —
   * the text lands in the revision dialog and goes through the revision
   * pipeline when the user submits it). */
  async function rewriteSelection(input: {
    text: string;
    instruction?: string;
    before?: string;
    after?: string;
  }): Promise<{ text: string }> {
    const selectedText = String(input?.text ?? "");
    if (!selectedText.trim()) {
      throw Object.assign(new Error("empty selection"), {
        errorCode: "NOT_SUPPORTED",
      });
    }
    const oneShot = await getOneShotProvider();
    if (!oneShot) {
      throw Object.assign(new Error("model not configured"), {
        errorCode: "MODEL_NOT_CONFIGURED",
      });
    }
    const { REWRITE_SYSTEM_PROMPT, buildRewriteUserPrompt, cleanRewriteOutput } =
      await import("./revision-review");
    const result = await completeOneShot(
      oneShot.provider,
      {
        systemPrompt: REWRITE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user" as const,
            content: buildRewriteUserPrompt(
              selectedText,
              String(input?.instruction ?? ""),
              { before: input?.before, after: input?.after },
            ),
            timestamp: Date.now(),
          },
        ],
      },
      oneShot.thinkingLevel,
      { sessionId: "space-rewrite" },
    );
    return { text: cleanRewriteOutput(result.text ?? "", selectedText) };
  }

  const kbService = new KbService({
    getHost,
    getLogger: () => logger,
  });

  // Module 04: IM channels — registry, adapters, and channel IPC. Messages
  // that pass the allowlist dispatch through the headless driver and the
  // result is sent back over the channel adapter.
  let spaceHost: ReturnType<typeof createSpaceIpcHost> | undefined;
  let spaceClient: ReturnType<typeof createSpaceClient> | undefined;
  let yjsBridgeDisposal: (() => void) | undefined;
  /** Org-session accessors for channel adapters that need them (wechat_mp). */
  const orgChannelContext: {
    tokenProvider?: () => Promise<string>;
    serverUrl?: () => string | undefined;
  } = {};
  // T6.2-a: channel credentials persist across restarts. host-core exposes a
  // sealed secret table (AES-256-GCM at rest) with `secrets.getForRuntime` as
  // the main-process plain read — so the SEAM promised by the credential
  // store's module doc is wired here, with memory as the hot cache.
  const channelCredentialStore = createChannelCredentialStore();
  channelCredentialStore.setSecretStore({
    async set(secretRef, value) {
      const h = host();
      if (!h) throw new Error("host unavailable");
      await h.call("secrets.set", { secretRef, value });
    },
    async get(secretRef) {
      const h = host();
      if (!h) return null;
      const result = await h.call<{ value?: string | null }>("secrets.getForRuntime", {
        secretRef,
      });
      return typeof result?.value === "string" && result.value.length > 0
        ? result.value
        : null;
    },
    async delete(secretRef) {
      const h = host();
      if (!h) return;
      await h.call("secrets.delete", { secretRef });
    },
  });

  const channelHost = createChannelRegistryHost({
    getLogger: () => logger,
    getDriver: () => headlessAgentDriver,
    credentialStore: channelCredentialStore,
    // FR-IM-01/02 persistence: credential-free account records live in the
    // host DB (migration v21); secrets stay in the sealed secrets table.
    loadAccounts: async () => {
      const h = host();
      if (!h) return [];
      const result = await h.call<{ accounts?: Array<Record<string, unknown>> }>(
        "channelAccounts.list",
      );
      return (result.accounts ?? []).map((record) => ({
        id: String(record.id),
        provider: record.provider as ChannelAccount["provider"],
        name: String(record.name ?? ""),
        secretRef: typeof record.secretRef === "string" ? record.secretRef : undefined,
        scope: record.scope as ChannelAccount["scope"],
        allowlist: Array.isArray(record.allowlist) ? record.allowlist.map(String) : [],
        enabled: record.enabled !== false,
      })) as ChannelAccount[];
    },
    saveAccounts: async (accounts) => {
      const h = host();
      if (!h) return;
      await h.call("channelAccounts.replaceAll", {
        accounts: accounts.map((account) => ({
          id: account.id,
          provider: account.provider,
          name: account.name,
          secretRef: account.secretRef ?? null,
          scope: account.scope,
          allowlist: account.allowlist,
          enabled: account.enabled,
        })),
      });
    },
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

  /** FR-PPT-14: org slide-template packs land under the user template dir. */
  async function applyOrgSlideTemplates(): Promise<void> {
    const bootstrap = orgService.getBootstrap() as {
      slideTemplates?: Array<{
        id: string;
        name: string;
        version: number;
        contract: Record<string, unknown>;
        usageNote?: string;
      }>;
    } | null;
    const items = bootstrap?.slideTemplates ?? [];
    if (!items.length) return;
    const root = join(homedir(), ".laboflow", "slide-templates");
    const fs = await import("node:fs");
    const indexPath = join(root, "index.json");
    const index = fs.existsSync(indexPath)
      ? (JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>)
      : {};
    const registry = (index.templates as Array<Record<string, unknown>>) ?? [];
    for (const item of items) {
      const dir = join(root, item.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        join(dir, "template.json"),
        JSON.stringify({ name: item.name, version: item.version, contract: item.contract, usageNote: item.usageNote, source: "org" }, null, 2),
      );
      const existing = registry.find((entry) => entry.id === item.id);
      const meta = { id: item.id, name: item.name, version: item.version, source: "org" };
      if (existing) Object.assign(existing, meta);
      else registry.push(meta);
      try {
        const content = (await orgService.getOrgJson(
          `/org/slide-templates/${encodeURIComponent(item.id)}/content`,
        )) as { contentBase64?: string };
        if (content?.contentBase64) {
          fs.writeFileSync(join(dir, "pack.base64"), content.contentBase64);
        }
      } catch (error) {
        logger.app("slides", "warn", "org template pack fetch failed", { data: `${item.id}: ${String(error)}` });
      }
    }
    index.updatedAt = new Date().toISOString();
    index.templates = registry;
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
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
  // Restore persisted channel accounts (FR-IM-01/02) once the host is up.
  void (async () => {
    try {
      let h: ReturnType<typeof host> = null;
      for (let attempt = 0; attempt < 15 && !h; attempt++) {
        h = host();
        if (!h) await new Promise((r) => setTimeout(r, 2000));
      }
      if (h) await channelHost.registry.init();
    } catch (error) {
      logger.app("channels", "warn", "channel accounts restore failed", { data: String(error) });
    }
  })();

  // Module 03/T53.3: local webhook server. Secret lives in the sealed
  // secrets table (generated on first boot); the task runner shares the
  // headless driver with channels and scheduled runs.
  const webhookServer = createWebhookServer({
    config: {
      secret: "pending",
      port: 3800,
      lanOpen: false,
      syncBudgetMs: 30_000,
    },
    runner: async ({ message }) => {
      const h = host();
      if (!h) throw new Error("host unavailable");
      const { ensureAssistantSession } = await import("../assistant/im-assistant");
      const { sessionId } = await ensureAssistantSession(h);
      const handle = await headlessAgentDriver.start({
        sessionId,
        prompt: message,
        unattendedPolicy: "degraded",
        timeoutMs: 15 * 60_000,
      });
      const result = await handle.completion;
      if (result.status !== "completed") {
        throw new Error(result.errorCode ?? "headless run failed");
      }
      // FR-MC-03: files the turn produced ride back to the caller.
      let files: string[] = [];
      try {
        const listed = await h.call<{ artifacts?: Array<{ path: string; op: string }> }>(
          "artifacts.list",
          { sessionId: handle.sessionId, limit: 20 },
        );
        files = (listed.artifacts ?? [])
          .filter((a) => a.op === "export" || a.op === "write")
          .map((a) => a.path)
          .slice(0, 10);
      } catch {
        // artifacts unavailable: still return the reply without files
      }
      return { reply: result.finalText, files };
    },
    listSchedules: async () => {
      const h = host();
      if (!h) return [];
      return h.call("scheduled.list", {});
    },
    log: (level, message) => logger.app("assistant", level, "webhook", { data: message }),
  });
  void (async () => {
    try {
      // The host comes up shortly after the service factory runs; poll for it
      // instead of giving up silently (the card would otherwise read 已停止
      // forever after a slow boot).
      let h: ReturnType<typeof host> = null;
      for (let attempt = 0; attempt < 15 && !h; attempt++) {
        h = host();
        if (!h) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!h) {
        logger.app("assistant", "warn", "webhook boot gave up: host unavailable");
        return;
      }
      const secretRef = "assistant.webhook.secret";
      const existing = await h.call<{ value?: string | null }>("secrets.getForRuntime", { secretRef });
      let secret = existing?.value ?? "";
      if (!secret) {
        secret = `wf_${randomUUID().replace(/-/g, "")}`;
        await h.call("secrets.set", { secretRef, value: secret });
      }
      webhookServer.reconfigure({ secret });
      await webhookServer.start();
    } catch (error) {
      logger.app("assistant", "warn", "webhook start failed", { data: String(error) });
    }
  })();

  spaceHost = createSpaceIpcHost({
    client: (spaceClient = createSpaceClient({
      getJson: (path) => orgService.getOrgJson(path),
      postJson: (path, body) => orgService.postOrgJson(path, body),
      patchJson: (path, body) => spaceOrgRequest("PATCH", path, body),
      putJson: (path, body) => spaceOrgRequest("PUT", path, body),
      deleteJson: (path) => spaceOrgRequest("DELETE", path),
    })),
    reviewByComments: (spaceId, nodeId) => reviewByComments(spaceId, nodeId),
    rewriteSelection: (input) => rewriteSelection(input),
    emit: (frame) => sendToRenderer(IPC.event.spaceEvent, frame),
    warn: (context, message) =>
      logger.app("session", "warn", "space events poll", {
        data: `${context}: ${message}`,
      }),
  });

  function applyOrgDeliveryOnConnect(): void {
    applyOrgExpertPacks();
    void applyOrgSlideTemplates().catch((error) =>
      logger.app("slides", "warn", "org slide templates delivery failed", { data: String(error) }),
    );
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
    // LaboFlow handlers must return the same Result envelope the upstream
    // `wrap` produces (renderer's api.invoke unwraps `ok`/`error`).
    const laboflowHandle: IpcHandler = (channel, fn) =>
      handle(channel, async (...args: any[]) => {
        try {
          return ok(await fn(...args));
        } catch (e: any) {
          return err(
            e?.data?.errorCode || e?.errorCode || "INTERNAL",
            e instanceof Error ? e.message : String(e),
            { retriable: e?.data?.retriable === true, details: e?.data },
          );
        }
      });
    const laboflowHandleWithEvent: IpcHandlerWithEvent = (channel, fn) =>
      handleWithEvent(channel, async (event, ...args: any[]) => {
        try {
          return ok(await fn(event, ...args));
        } catch (e: any) {
          return err(
            e?.data?.errorCode || e?.errorCode || "INTERNAL",
            e instanceof Error ? e.message : String(e),
            { retriable: e?.data?.retriable === true, details: e?.data },
          );
        }
      });

    // Module 04: channel accounts + connect/test lifecycle IPC (registry-owned).
    channelHost.registerIpc(laboflowHandle);
    // Module 02: team-space tree/docs/comments/revisions/events IPC.
    spaceHost?.registerIpc(laboflowHandle);

    laboflowHandleWithEvent(IPC.invoke.spaceClip, async (event, input: { url?: unknown }) => {
      deps.assertMainWindowSender(event);
      const url = typeof input?.url === "string" ? input.url : "";
      const { clipWebPage } = await import("../web-clipper");
      return clipWebPage(url);
    });

    // T53.5: assistant-mode page session (persistent, unified history).
    laboflowHandleWithEvent(
      IPC.invoke.spaceSaveFromPath,
      async (event, input: { path?: unknown; spaceId?: unknown; parentId?: unknown; name?: unknown }) => {
        deps.assertMainWindowSender(event);
        const filePath = String(input?.path ?? "").trim();
        const spaceId = String(input?.spaceId ?? "").trim();
        if (!filePath || !spaceId) {
          throw Object.assign(new Error("invalid save input"), { errorCode: "INVALID_ARGUMENT" });
        }
        if (!spaceClient) throw new Error("space client unavailable");
        const { readFile } = await import("node:fs/promises");
        const { basename } = await import("node:path");
        const content = await readFile(filePath);
        const name = String(input?.name ?? "").trim() || basename(filePath);
        return spaceClient.uploadFile(spaceId, {
          parentId: (input?.parentId ?? null) as string | null,
          name,
          contentBase64: content.toString("base64"),
        });
      },
    );

    laboflowHandleWithEvent(IPC.invoke.assistantSessionGet, async (event) => {
      deps.assertMainWindowSender(event);
      const h = host();
      if (!h) throw new Error("host unavailable");
      return ensureAssistantSessionCached(h);
    });
    laboflowHandleWithEvent(
      IPC.invoke.assistantHistory,
      async (event, input: { sessionId?: unknown }) => {
        deps.assertMainWindowSender(event);
        const h = host();
        if (!h) throw new Error("host unavailable");
        const sessionId = String(input?.sessionId ?? "");
        const { assistantHistory } = await import("../assistant/im-assistant");
        return assistantHistory(h, sessionId);
      },
    );
    laboflowHandleWithEvent(
      IPC.invoke.assistantSend,
      async (event, input: { sessionId?: unknown; text?: unknown }) => {
        deps.assertMainWindowSender(event);
        const sessionId = String(input?.sessionId ?? "");
        const text = String(input?.text ?? "").trim();
        if (!sessionId || !text) {
          throw Object.assign(new Error("invalid assistant send"), {
            errorCode: "INVALID_ARGUMENT",
          });
        }
        void (async () => {
          try {
            const { dispatchAssistantTurn } = await import("../assistant/im-assistant");
            const result = await dispatchAssistantTurn(headlessAgentDriver, sessionId, text);
            sendToRenderer(IPC.event.assistantTurnDone, {
              sessionId,
              finalText: result.finalText,
              status: result.status,
            });
          } catch (error) {
            sendToRenderer(IPC.event.assistantTurnDone, {
              sessionId,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return { started: true };
      },
    );
    // Module 03/T53.3: webhook settings (read masked status / reconfigure).
    laboflowHandleWithEvent(IPC.invoke.assistantWebhookGet, async (event) => {
      deps.assertMainWindowSender(event);
      return webhookServer.describe();
    });
    laboflowHandleWithEvent(
      IPC.invoke.assistantWebhookSet,
      async (event, input: { port?: unknown; lanOpen?: unknown }) => {
        deps.assertMainWindowSender(event);
        return webhookServer.reconfigure({
          ...(Number.isFinite(Number(input?.port)) ? { port: Number(input.port) } : {}),
          ...(typeof input?.lanOpen === "boolean" ? { lanOpen: input.lanOpen } : {}),
        });
      },
    );

    // Module 02/T52.13: yjs CRDT frame bridge (token stays main-side).
    yjsBridgeDisposal = createYjsBridge({
      orgService,
      handle: laboflowHandle,
      handleWithEvent: laboflowHandleWithEvent,
      forward: (channel, payload) =>
        sendToRenderer(IPC.event.spaceYjsFrame, { channel, ...payload }),
      assertMainWindowSender: (event) => deps.assertMainWindowSender(event),
      warn: (context, message) =>
        logger.app("space", "info", "yjs bridge", { data: `${context}: ${message}` }),
    }).dispose;

    laboflowHandleWithEvent(
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

    // Team-space doc reference (FR-TC-17): snapshot a server-side space
    // document into the session scratch dir so the composer can attach it
    // like an imported file. The fetch rides the user's own org credentials,
    // so the permission filter stays server-authoritative.
    laboflowHandle(
      IPC.invoke.composerAttachSpaceDoc,
      async (
        event,
        input: {
          sessionId?: unknown;
          spaceId?: unknown;
          nodeId?: unknown;
        } = {},
      ) => {
        const { attachSpaceDoc } = await import("../session-attach");
        deps.assertMainWindowSender(event);
        if (!spaceClient) throw new Error("space client unavailable");
        const sessionId =
          typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        const spaceId =
          typeof input.spaceId === "string" ? input.spaceId.trim() : "";
        const nodeId =
          typeof input.nodeId === "string" ? input.nodeId.trim() : "";
        if (!sessionId || !spaceId || !nodeId) {
          throw Object.assign(new Error("invalid space attach input"), {
            errorCode: "INVALID_ARGUMENT",
          });
        }
        const nodes = await spaceClient.tree(spaceId);
        const node = nodes.find((entry) => entry.id === nodeId);
        if (!node) {
          throw Object.assign(new Error("space node not found"), {
            errorCode: "NOT_FOUND",
          });
        }
        if (node.type !== "md" && node.type !== "csv" && node.type !== "html") {
          throw Object.assign(
            new Error("only md/csv/html documents can be attached"),
            { errorCode: "NOT_SUPPORTED" },
          );
        }
        if (node.perm === "none") {
          throw Object.assign(new Error("no access to this document"), {
            errorCode: "FORBIDDEN",
          });
        }
        const spaces = await spaceClient.listSpaces();
        const spaceName =
          spaces.find((space) => space.id === spaceId)?.name ?? spaceId;
        const doc = await spaceClient.getDoc(spaceId, nodeId);
        const saved = await attachSpaceDoc(
          dataDir,
          sessionId,
          node.name,
          node.type,
          spaceName,
          doc.content ?? "",
        );
        return { files: [saved] };
      },
    );

    // Expert center (module 01)
    laboflowHandle(IPC.invoke.expertList, async () => expertService.list());
    laboflowHandle(
      IPC.invoke.expertGet,
      async (req: { id: string }) => expertService.get(String(req?.id ?? "").trim()),
    );
    laboflowHandle(IPC.invoke.expertSave, async (input: Record<string, unknown>) =>
      expertService.save(input ?? {}),
    );
    laboflowHandle(IPC.invoke.expertDelete, async (req: { id: string }) =>
      expertService.delete(String(req?.id ?? "").trim()),
    );
    laboflowHandle(
      IPC.invoke.expertToggle,
      async (req: { id: string; enabled: boolean }) =>
        expertService.toggle(String(req?.id ?? "").trim(), req?.enabled === true),
    );
    laboflowHandle(
      IPC.invoke.expertInvoke,
      async (req: { sessionId?: string; expertId: string; task: string }) =>
        expertService.invoke({
          sessionId: req?.sessionId,
          expertId: String(req?.expertId ?? "").trim(),
          task: String(req?.task ?? "").trim(),
        }),
    );
    // FR-E-17: serial multi-expert chain; the first session returns
    // immediately, later steps dispatch as earlier turns settle.
    laboflowHandle(
      IPC.invoke.expertChainInvoke,
      async (req: {
        sessionId?: string;
        steps: Array<{ expertId: string; name: string; task: string }>;
      }) => {
        const steps = (Array.isArray(req?.steps) ? req.steps : [])
          .map((step) => ({
            expertId: String(step?.expertId ?? "").trim(),
            name: String(step?.name ?? "").trim(),
            task: String(step?.task ?? "").trim(),
          }))
          .filter((step) => step.expertId && step.task);
        if (steps.length < 2) {
          throw Object.assign(
            new Error("a chain needs at least two expert steps"),
            { errorCode: "NOT_SUPPORTED" },
          );
        }
        return startExpertChain(
          {
            invokeWithCompletion: (request) =>
              expertService.invokeWithCompletion(request),
            postSessionCard,
            broadcast: (event) => sendToRenderer(IPC.event.expertTeamRun, event),
            logger,
          },
          steps,
          req?.sessionId,
        );
      },
    );
    laboflowHandle(IPC.invoke.expertTeamsList, async () => expertService.listTeams());
    laboflowHandle(
      IPC.invoke.expertTeamGet,
      async (req: { id: string }) => {
        const h = requireHost();
        return h.call("expertTeams.read", { id: String(req?.id ?? "").trim() });
      },
    );
    laboflowHandle(IPC.invoke.expertTeamSave, async (input: Record<string, unknown>) => {
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
    laboflowHandle(IPC.invoke.expertTeamDelete, async (req: { id: string }) => {
      const h = requireHost();
      return h.call("expertTeams.remove", { id: String(req?.id ?? "").trim() });
    });
    laboflowHandle(
      IPC.invoke.expertTeamInvoke,
      async (req: { sessionId?: string; teamId: string; task: string }) =>
        teamRunner.invoke({
          sessionId: req?.sessionId,
          teamId: String(req?.teamId ?? "").trim(),
          task: String(req?.task ?? "").trim(),
        }),
    );
    laboflowHandle(
      IPC.invoke.expertTeamRetryMember,
      async (req: { runId: string; index: number }) =>
        teamRunner.retryMember({
          runId: String(req?.runId ?? "").trim(),
          index: Number(req?.index ?? -1),
        }),
    );

    // Knowledge base (module 05)
    laboflowHandle(IPC.invoke.kbListUrls, async () => kbService.listUrls());
    laboflowHandle(
      IPC.invoke.kbSaveUrl,
      async (req: { name: string; url: string }) => kbService.saveUrl(req ?? {}),
    );
    laboflowHandle(IPC.invoke.kbDeleteUrl, async (req: { id: string }) =>
      kbService.deleteUrl(String(req?.id ?? "").trim()),
    );
    laboflowHandle(
      IPC.invoke.kbApplyOrgDelivery,
      async (req: { orgId: string; items: KbServerDelivery[] }) =>
        kbService.applyOrgDelivery(String(req?.orgId ?? "").trim(), req?.items ?? []),
    );
    laboflowHandle(IPC.invoke.kbDisableOrgServers, async () => kbService.disableOrgServers());
    // FR-KB-14: per-day retrieval usage for the usage page (settings blob).
    laboflowHandle(IPC.invoke.kbUsageHistory, async () => {
      const settings = await requireHost()
        .call<{ kbUsage?: KbUsageLedger }>("settings.get")
        .catch(() => undefined);
      return kbUsageHistory(settings?.kbUsage);
    });

    // Organization session + Phase 3 provider + Phase 4 workspaces
    laboflowHandle(
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
    laboflowHandle(IPC.invoke.orgStatus, async () => {
      const status = await orgService.status();
      if (status.state === "connected") {
        await syncOrgProvider();
        applyOrgDeliveryOnConnect();
      }
      return status;
    });
    laboflowHandle(IPC.invoke.orgChangePassword, (input: { currentPassword: string; newPassword: string }) =>
      orgService.changePassword(input),
    );
    laboflowHandle(IPC.invoke.orgLogout, async () => {
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
    laboflowHandle(IPC.invoke.orgSetCurrent, async (input: { key: string }) => {
      const status = await orgService.setCurrent(String(input?.key ?? ""));
      if (status.state === "connected") await syncOrgProvider();
      return status;
    });
    laboflowHandle(IPC.invoke.orgQuotaRemaining, () => orgService.quotaRemaining());
    laboflowHandle(IPC.invoke.orgRemoveSession, (input: { key: string }) =>
      orgService.removeSession(String(input?.key ?? "")),
    );
    laboflowHandle(
      IPC.invoke.orgSetSessionEnabled,
      (input: { key: string; enabled: boolean }) =>
        orgService.setSessionEnabled(String(input?.key ?? ""), Boolean(input.enabled)),
    );
    laboflowHandle(IPC.invoke.orgWsSessions, (input: { wid: string }) =>
      orgService.getOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions`,
      ),
    );
    laboflowHandle(
      IPC.invoke.orgWsCreateSession,
      (input: { wid: string; title: string }) =>
        orgService.postOrgJson(
          `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions`,
          { title: String(input?.title ?? "共享会话") },
        ),
    );
    laboflowHandle(
      IPC.invoke.orgWsEntries,
      (input: { wid: string; sid: string; since?: number }) =>
        orgService.getOrgJson(
          `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions/${encodeURIComponent(String(input?.sid ?? ""))}/entries?since=${Number(input?.since ?? -1)}`,
        ),
    );
    laboflowHandle(IPC.invoke.orgWsConnect, async (input: { wid: string; sid: string }) => {
      await orgHub.connect(String(input?.wid ?? ""), String(input?.sid ?? ""));
      return { ok: true };
    });
    laboflowHandle(IPC.invoke.orgWsDisconnect, async (input: { sid: string }) => {
      orgHub.disconnect(String(input?.sid ?? ""));
      return { ok: true };
    });
    laboflowHandle(IPC.invoke.orgWsLock, (input: { wid: string; sid: string }) =>
      orgService.postOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions/${encodeURIComponent(String(input?.sid ?? ""))}/lock`,
        {},
      ),
    );
    laboflowHandle(IPC.invoke.orgWsRelease, async (input: { wid: string; sid: string }) =>
      orgService.postOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/sessions/${encodeURIComponent(String(input?.sid ?? ""))}/release`,
        {},
      ),
    );
    laboflowHandle(
      IPC.invoke.orgWsSay,
      async (input: { wid: string; sid: string; text: string }) =>
        orgHub.say(String(input?.wid ?? ""), String(input?.sid ?? ""), String(input?.text ?? "")),
    );
    laboflowHandle(IPC.invoke.orgWsDeliverables, (input: { wid: string }) =>
      orgService.getOrgJson(
        `/workspaces/${encodeURIComponent(String(input?.wid ?? ""))}/deliverables`,
      ),
    );
    laboflowHandle(
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
    laboflowHandle(
      IPC.invoke.orgWsDeliverableDownload,
      (input: { did: string; version?: number }) =>
        orgService.getOrgJson(
          `/deliverables/${encodeURIComponent(String(input?.did ?? ""))}/download${input?.version ? `?version=${input.version}` : ""}`,
        ),
    );

    // Pull requests of the active workspace (fork page kept through the merge)
    laboflowHandle(IPC.invoke.pullsList, async () => {
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
    laboflowHandle(
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
    laboflowHandle(IPC.invoke.statsGetTokenInsights, async () => {
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
      channelCredentialStore,
      getSpaceHost: () => spaceHost,
    },
    registerIpc,
  };
}

export type LaboflowServices = ReturnType<typeof createLaboflowServices>;
