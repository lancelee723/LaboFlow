/**
 * ChannelRegistry (module 04, SPEC §3.1) — adapter lifecycle, inbound
 * filtering, and the dispatch bridge into the HeadlessAgentDriver.
 *
 * Responsibilities:
 *   - Account CRUD (`channels/save|delete|list`). Credentials arrive as
 *     plaintext over IPC, live only in the ChannelCredentialStore, and are
 *     never echoed back: every IPC response uses sanitized views.
 *   - Lifecycle state machine per account: disconnected → connecting →
 *     connected | error (with DiagInfo). State changes broadcast via
 *     `onStateChange` (wired to `IPC.event.channelState`).
 *   - Inbound filtering BEFORE dispatch (SPEC §3.1: 白名单过滤在 registry 层
 *     统一做): scope check (p2p/group/both), allowlist check
 *     (fail-closed — an empty allowlist allows nobody; users add their own
 *     feishu open_id / wecom userid on save), non-empty text.
 *   - Dispatch: one agent run per inbound message through `getDriver().start`
 *     with a per-chat serial queue — messages from the same chat run one at
 *     a time (later messages wait), different chats run concurrently. On
 *     completion the final text is pushed back via adapter.send, or the
 *     fallback "（任务结束，无文本结果）".
 *
 * Persistence seam: `loadAccounts`/`saveAccounts` are optional. When the
 * host-core `channel_accounts` table (migration v15) lands, main wires them;
 * until then accounts live for the session only and the saved snapshot is
 * always credential-free.
 *
 * NOTE: keep runtime imports limited to node builtins + `@pi-desktop/shared`
 * so plain-node tests can load this file directly (local imports stay
 * `import type`).
 */

import { randomUUID } from "node:crypto";

import {
  IPC,
  type ChannelAccount,
  type ChannelProvider,
  type ChannelState,
  type DiagInfo,
  type InboundMessage,
} from "@pi-desktop/shared";

import type {
  ChannelAccountSaveInput,
  ChannelAccountView,
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelDriver,
  ChannelLogger,
  ChannelStateEvent,
  ChannelTestResult,
} from "./types";
import type { ChannelCredentialStore } from "./credential-store";

const NO_TEXT_REPLY = "（任务结束，无文本结果）";
const DRIVER_NOT_READY_REPLY = "LaboFlow 后端尚未就绪，请稍后再试";

export interface ChannelRegistryDeps {
  /** Agent execution engine (createHeadlessAgentDriver in index.ts). */
  getDriver(): ChannelDriver | null;
  getLogger(): ChannelLogger;
  /** Adapter factories per provider; partial so new providers (wechat_mp) can register without touching index.ts all at once. */
  adapters: Partial<Record<ChannelProvider, ChannelAdapterFactory>>;
  /** Secret holder (createChannelCredentialStore from credential-store.ts). */
  credentialStore: ChannelCredentialStore;
  /** Module 03 hook: fired after a message passes scope + allowlist. */
  onInbound?(message: InboundMessage): void;
  /** State-change broadcast (wired to `IPC.event.channelState`). */
  onStateChange?(event: ChannelStateEvent): void;
  loadAccounts?(): Promise<ChannelAccount[]>;
  saveAccounts?(accounts: ChannelAccount[]): Promise<void>;
}

interface AccountRuntime {
  state: ChannelState;
  diag?: DiagInfo;
  lastConnectedAt?: number;
  /** Credential keys stored for this account (refs derive from these). */
  credentialKeys: Set<string>;
}

function credentialRef(accountId: string, key: string): string {
  return `channel:${accountId}:${key}`;
}

function normalizeAllowlist(allowlist: string[]): string[] {
  const seen = new Set<string>();
  for (const entry of allowlist) {
    const trimmed = typeof entry === "string" ? entry.trim() : "";
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

export class ChannelRegistry {
  private deps: ChannelRegistryDeps;
  private accounts = new Map<string, ChannelAccount>();
  private runtimes = new Map<string, AccountRuntime>();
  private adaptersByAccount = new Map<string, ChannelAdapter>();
  /** chatRef → tail of the serial dispatch chain for that chat. */
  private queues = new Map<string, Promise<void>>();
  private credentials: ChannelCredentialStore;

  constructor(deps: ChannelRegistryDeps) {
    this.deps = deps;
    this.credentials = deps.credentialStore;
  }

  /** Test/relay access to the credential store (e.g. setSecretStore). */
  getCredentialStore(): ChannelCredentialStore {
    return this.credentials;
  }

  /** Restore accounts injected by a persistence seam (credentials excluded). */
  async init(): Promise<void> {
    if (!this.deps.loadAccounts) return;
    try {
      const stored = await this.deps.loadAccounts();
      for (const account of stored) {
        const clean = { ...account, credentials: undefined };
        this.accounts.set(clean.id, clean);
        this.runtimes.set(clean.id, {
          state: "disconnected",
          credentialKeys: new Set(),
        });
      }
    } catch (error) {
      this.deps.getLogger().app("channels", "warn", "channel accounts restore failed", {
        data: String(error),
      });
    }
  }

  private runtime(accountId: string): AccountRuntime {
    let runtime = this.runtimes.get(accountId);
    if (!runtime) {
      runtime = { state: "disconnected", credentialKeys: new Set() };
      this.runtimes.set(accountId, runtime);
    }
    return runtime;
  }

  private sanitize(account: ChannelAccount): ChannelAccountView {
    const runtime = this.runtime(account.id);
    return {
      id: account.id,
      provider: account.provider,
      name: account.name,
      scope: account.scope,
      allowlist: account.allowlist,
      enabled: account.enabled,
      hasCredentials: runtime.credentialKeys.size > 0,
      state: runtime.state,
      ...(runtime.diag ? { diag: runtime.diag } : {}),
      ...(runtime.lastConnectedAt ? { lastConnectedAt: runtime.lastConnectedAt } : {}),
    };
  }

  private async persist(): Promise<void> {
    if (!this.deps.saveAccounts) return;
    try {
      const snapshot = [...this.accounts.values()].map((account) => ({
        ...account,
        credentials: undefined,
      }));
      await this.deps.saveAccounts(snapshot);
    } catch (error) {
      this.deps.getLogger().app("channels", "warn", "channel accounts persist failed", {
        data: String(error),
      });
    }
  }

  private setState(accountId: string, state: ChannelState, diag?: DiagInfo): void {
    const runtime = this.runtime(accountId);
    runtime.state = state;
    runtime.diag = state === "error" || state === "connected" ? diag : undefined;
    if (state === "connected") runtime.lastConnectedAt = Date.now();
    const account = this.accounts.get(accountId);
    if (account) {
      this.deps.onStateChange?.({
        accountId,
        provider: account.provider,
        state,
        ...(state === "error" || state === "connected" ? { diag: runtime.diag } : {}),
        ...(runtime.lastConnectedAt ? { lastConnectedAt: runtime.lastConnectedAt } : {}),
      });
    }
  }

  list(): ChannelAccountView[] {
    return [...this.accounts.values()]
      .map((account) => this.sanitize(account))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }

  async save(input: ChannelAccountSaveInput): Promise<ChannelAccountView> {
    if (input.provider !== "feishu" && input.provider !== "wecom" && input.provider !== "wechat_mp") {
      throw new Error(`unsupported channel provider: ${String(input.provider)}`);
    }
    const existing = input.id ? this.accounts.get(input.id) : undefined;
    if (input.id && !existing) {
      throw new Error(`channel account not found: ${input.id}`);
    }
    const id = existing?.id ?? randomUUID();

    const account: ChannelAccount = {
      id,
      provider: input.provider,
      name: input.name?.trim() || existing?.name || input.provider,
      scope: input.scope ?? existing?.scope ?? "both",
      allowlist:
        input.allowlist !== undefined
          ? normalizeAllowlist(input.allowlist)
          : (existing?.allowlist ?? []),
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
    this.accounts.set(id, account);
    this.runtime(id); // ensure runtime row exists

    // Empty/whitespace credential values mean "unchanged" (FR-IM-02) and are
    // never written — they cannot clobber an existing working secret.
    const runtime = this.runtime(id);
    for (const [key, value] of Object.entries(input.credentials ?? {})) {
      const stored = await this.credentials.put(credentialRef(id, key), value);
      if (stored) runtime.credentialKeys.add(key);
    }

    await this.persist();
    return this.sanitize(account);
  }

  async delete(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;
    await this.disconnect(accountId).catch(() => undefined);
    const runtime = this.runtime(accountId);
    for (const key of runtime.credentialKeys) {
      await this.credentials.delete(credentialRef(accountId, key));
    }
    this.accounts.delete(accountId);
    this.runtimes.delete(accountId);
    this.adaptersByAccount.delete(accountId);
    await this.persist();
  }

  private async hydrateCredentials(accountId: string): Promise<Record<string, string>> {
    const runtime = this.runtime(accountId);
    const credentials: Record<string, string> = {};
    for (const key of runtime.credentialKeys) {
      const value = await this.credentials.get(credentialRef(accountId, key));
      if (value !== null) credentials[key] = value;
    }
    return credentials;
  }

  private getOrCreateAdapter(account: ChannelAccount): ChannelAdapter {
    const existing = this.adaptersByAccount.get(account.id);
    if (existing) return existing;
    const factory = this.deps.adapters[account.provider];
    if (!factory) {
      throw new Error(`no adapter registered for provider ${account.provider}`);
    }
    const adapter = factory(account.id);
    adapter.onMessage((message) => this.handleInbound(account.id, message));
    adapter.onState((state, diag) => {
      // The registry owns the connect() handshake transitions; adapter
      // reports only contribute runtime drops/reconnects after that.
      const current = this.runtime(account.id).state;
      if (current === "connecting") return;
      if (current === state) return;
      this.setState(account.id, state, diag);
    });
    this.adaptersByAccount.set(account.id, adapter);
    return adapter;
  }

  async connect(accountId: string): Promise<ChannelAccountView> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`channel account not found: ${accountId}`);
    if (!account.enabled) {
      throw new Error("channel account is disabled");
    }

    const existing = this.adaptersByAccount.get(accountId);
    if (existing) await existing.disconnect().catch(() => undefined);

    this.setState(accountId, "connecting");
    const adapter = this.getOrCreateAdapter(account);
    try {
      const credentials = await this.hydrateCredentials(accountId);
      if (Object.keys(credentials).length === 0) {
        const diag: DiagInfo = {
          kind: "credential",
          message: "尚未保存任何凭证，请先在卡片中粘贴并保存",
        };
        this.setState(accountId, "error", diag);
        throw Object.assign(new Error(diag.message), { diag });
      }
      await adapter.connect({ ...account, credentials });
      this.setState(accountId, "connected");
    } catch (error) {
      const diag = (error as { diag?: DiagInfo } | null)?.diag;
      this.setState(accountId, "error", diag ?? { kind: "unknown", message: String(error) });
      throw error;
    }
    return this.sanitize(account);
  }

  async disconnect(accountId: string): Promise<ChannelAccountView> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`channel account not found: ${accountId}`);
    const adapter = this.adaptersByAccount.get(accountId);
    if (adapter) {
      await adapter.disconnect().catch(() => undefined);
    }
    this.setState(accountId, "disconnected");
    return this.sanitize(account);
  }

  /** Connection health check (FR-IM-03) — no state flip, returns DiagInfo. */
  async test(accountId: string): Promise<ChannelTestResult> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`channel account not found: ${accountId}`);
    const credentials = await this.hydrateCredentials(accountId);
    const hydrated: ChannelAccount = { ...account, credentials };
    const attached = this.adaptersByAccount.get(accountId);
    const adapter = attached ?? this.deps.adapters[account.provider]?.(account.id);
    if (!adapter?.test) {
      return { ok: true };
    }
    const diag = await adapter.test(hydrated);
    return diag ? { ok: false, diag } : { ok: true };
  }

  // -------------------------------------------------------------------------
  // Inbound filtering + dispatch
  // -------------------------------------------------------------------------

  /** Adapter callback entry: scope + allowlist gate BEFORE any dispatch. */
  handleInbound(accountId: string, message: InboundMessage): void {
    const account = this.accounts.get(accountId);
    if (!account || !account.enabled) return;

    if (message.chatType === "p2p" && account.scope === "group") return;
    if (message.chatType === "group" && account.scope === "p2p") return;

    // Fail-closed: an empty allowlist allows nobody (default-仅本人 requires
    // the owner to paste their own platform id on save).
    if (account.allowlist.length === 0) {
      this.deps.getLogger().app("channels", "info", "inbound dropped: empty allowlist", {
        data: { accountId, chatType: message.chatType },
      });
      return;
    }
    if (!account.allowlist.includes(message.senderRef)) {
      // SPEC §4: 白名单外消息一律忽略（静默）.
      this.deps.getLogger().app("channels", "info", "inbound dropped: sender not allowlisted", {
        data: { accountId, chatType: message.chatType },
      });
      return;
    }
    if (!message.text.trim()) return;

    this.deps.onInbound?.(message);
    this.enqueueDispatch(account, message);
  }

  /**
   * Serial queue PER CHAT: one run at a time per chatRef; further messages
   * from the same chat wait for the previous run to finish. Different chats
   * proceed concurrently.
   */
  enqueueDispatch(account: ChannelAccount, message: InboundMessage): void {
    const tail = this.queues.get(message.chatRef) ?? Promise.resolve();
    const run = tail.then(
      () => this.dispatch(account, message),
      () => this.dispatch(account, message),
    );
    this.queues.set(message.chatRef, run);
    void run.finally(() => {
      if (this.queues.get(message.chatRef) === run) {
        this.queues.delete(message.chatRef);
      }
    });
  }

  private async dispatch(account: ChannelAccount, message: InboundMessage): Promise<void> {
    const logger = this.deps.getLogger();
    const adapter = this.adaptersByAccount.get(account.id);
    if (!adapter) return;
    // FR-IM-07: on card-capable channels the reply is ONE card bubble —
    // created as 受理中 when the task starts, patched in place with the final
    // content (streaming patches). Any card failure degrades to plain text.
    let cardMessageId: string | undefined;
    if (adapter.sendCard) {
      try {
        cardMessageId = await adapter.sendCard(message.chatRef, {
          replyText: message.text,
          replyCard: {
            title: message.text.slice(0, 40) || "任务",
            status: "运行中",
          },
        });
      } catch (error) {
        logger.app("channels", "warn", "channel accept-card send failed", {
          data: String(error),
        });
        cardMessageId = undefined;
      }
    }
    try {
      const driver = this.deps.getDriver();
      if (!driver) {
        await adapter.send(message.chatRef, { replyText: DRIVER_NOT_READY_REPLY });
        return;
      }
      const startedAt = Date.now();
      const handle = await driver.start({
        newSession: { title: `IM·${message.senderRef}` },
        prompt: message.text,
        unattendedPolicy: "degraded",
      });
      const result = await handle.completion;
      const elapsedMs = Date.now() - startedAt;
      const totalTokens = (result as { usage?: { totalTokens?: number } }).usage?.totalTokens;
      const finalText =
        result.status === "completed" && result.finalText.trim().length > 0
          ? result.finalText
          : result.status === "completed"
            ? NO_TEXT_REPLY
            : `任务未正常完成（${result.status}）`;
      const replyCard = {
        title: message.text.slice(0, 40) || "任务",
        status: result.status === "completed" ? "完成" : "失败",
        elapsedMs,
        ...(typeof totalTokens === "number" ? { totalTokens } : {}),
        text: finalText,
      };
      if (cardMessageId && adapter.patchCard) {
        try {
          await adapter.patchCard(cardMessageId, { replyText: finalText, replyCard });
          return;
        } catch (error) {
          logger.app("channels", "warn", "channel card patch failed, falling back to text", {
            data: String(error),
          });
        }
      }
      await adapter.send(message.chatRef, { replyText: finalText, replyCard });
    } catch (error) {
      logger.app("channels", "error", "channel dispatch failed", {
        data: { accountId: account.id, chatRef: message.chatRef, error: String(error) },
      });
      try {
        await adapter.send(message.chatRef, {
          replyText: `任务执行失败：${String(error)}`,
        });
      } catch (sendError) {
        logger.app("channels", "warn", "channel error-reply send failed", {
          data: String(sendError),
        });
      }
    }
  }

  /** Exposed for tests: number of pending/running chains per chat. */
  queueDepth(chatRef: string): number {
    return this.queues.has(chatRef) ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Host factory: builds the registry with the main-process deps and exposes
// the IPC handle() registrations for index.ts.
// ---------------------------------------------------------------------------

export interface ChannelRegistryHostDeps {
  getHost?(): { call<T = unknown>(method: string, params?: unknown): Promise<T> } | null;
  getLogger(): ChannelLogger;
  getDriver(): ChannelDriver | null;
  /** Adapter factories for every supported provider (main wires the real ones). */
  adapters: Partial<Record<ChannelProvider, ChannelAdapterFactory>>;
  /** Secret holder — pass `createChannelCredentialStore()` here. */
  credentialStore: ChannelCredentialStore;
  /** Renderer broadcast (wired to `IPC.event.channelState` via sendToRenderer). */
  broadcast?(event: ChannelStateEvent): void;
  /** Module 03 hook for assistant-history source annotation. */
  onInbound?(message: InboundMessage): void;
  loadAccounts?(): Promise<ChannelAccount[]>;
  saveAccounts?(accounts: ChannelAccount[]): Promise<void>;
}

export interface ChannelRegistryHost {
  registry: ChannelRegistry;
  /**
   * Register all `channels/*` handlers. Pass index.ts's `handle(channel, fn)`
   * wrapper so handlers go through the standard error envelope.
   */
  registerIpc(handle: (channel: string, fn: (...args: any[]) => Promise<any>) => void): void;
}

export function createChannelRegistryHost(
  deps: ChannelRegistryHostDeps,
): ChannelRegistryHost {
  const registry = new ChannelRegistry({
    getDriver: deps.getDriver,
    getLogger: deps.getLogger,
    adapters: deps.adapters,
    credentialStore: deps.credentialStore,
    ...(deps.onInbound ? { onInbound: deps.onInbound } : {}),
    onStateChange: (event) => deps.broadcast?.(event),
    ...(deps.loadAccounts ? { loadAccounts: deps.loadAccounts } : {}),
    ...(deps.saveAccounts ? { saveAccounts: deps.saveAccounts } : {}),
  });

  return {
    registry,
    registerIpc(handle) {
      handle(IPC.invoke.channelsList, async () => registry.list());
      handle(IPC.invoke.channelsSave, async (input: ChannelAccountSaveInput) =>
        registry.save(input),
      );
      handle(IPC.invoke.channelsDelete, async (accountId: string) =>
        registry.delete(String(accountId)),
      );
      handle(IPC.invoke.channelsConnect, async (accountId: string) =>
        registry.connect(String(accountId)),
      );
      handle(IPC.invoke.channelsDisconnect, async (accountId: string) =>
        registry.disconnect(String(accountId)),
      );
      handle(IPC.invoke.channelsTest, async (accountId: string) =>
        registry.test(String(accountId)),
      );
    },
  };
}
