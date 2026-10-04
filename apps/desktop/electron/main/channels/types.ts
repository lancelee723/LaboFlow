/**
 * Channel framework types (module 04, SPEC §3.1).
 *
 * Core value types (`ChannelAccount`, `ChannelState`, `DiagInfo`,
 * `InboundMessage`, `OutboundPayload`, `ChannelCapabilities`) live in
 * `@pi-desktop/shared` so the renderer can mirror them; this file adds the
 * main-process-only pieces: the `ChannelAdapter` contract every platform
 * implements, per-account views safe for IPC, and the driver seam the
 * registry dispatches through.
 *
 * Note: files under `channels/` are imported directly by plain-node tests
 * (type stripping, no bundler). Keep cross-file imports `import type` only —
 * runtime imports must stay limited to node builtins and `@pi-desktop/shared`.
 */

import type {
  ChannelAccount,
  ChannelCapabilities,
  ChannelProvider,
  ChannelState,
  DiagInfo,
  InboundMessage,
  OutboundPayload,
} from "@pi-desktop/shared";

// Boundary DTOs (account views, save input, test result, state events) live in
// shared so the renderer mirrors them without importing main-process code.
export type {
  ChannelAccount,
  ChannelAccountSaveInput,
  ChannelAccountScope,
  ChannelAccountView,
  ChannelCapabilities,
  ChannelProvider,
  ChannelState,
  ChannelStateEvent,
  ChannelTestResult,
  DiagInfo,
  InboundMessage,
  OutboundPayload,
} from "@pi-desktop/shared";

/**
 * Unified platform adapter. One instance per configured account; the
 * registry owns the lifecycle (connect/disconnect) and filters inbound
 * messages (scope + allowlist) before they reach the dispatcher.
 */
export interface ChannelAdapter {
  provider: ChannelProvider;
  capabilities: ChannelCapabilities;
  /** Establish the long connection / register the inbound consumer. */
  connect(account: ChannelAccount): Promise<void>;
  disconnect(): Promise<void>;
  /** Push a reply into the chat identified by the platform chat ref. */
  send(chatRef: string, payload: OutboundPayload): Promise<void>;
  /** Normalized inbound callback (dedup already applied by the adapter). */
  onMessage(cb: (message: InboundMessage) => void): void;
  onState(cb: (state: ChannelState, diag?: DiagInfo) => void): void;
  /**
   * Optional connection health check (FR-IM-03 连接体检). Receives the
   * account with hydrated credentials (no connect side effects); returns
   * null when healthy, a DiagInfo otherwise.
   */
  test?(account: ChannelAccount): Promise<DiagInfo | null>;
}

/** Creates one adapter instance for an account id (called per account). */
export type ChannelAdapterFactory = (channelId: string) => ChannelAdapter;

/**
 * The slice of HeadlessAgentDriver the registry needs (structural, so tests
 * can fake it and main can pass `createHeadlessAgentDriver(...)` directly).
 */
export interface ChannelDriver {
  start(request: {
    sessionId?: string;
    newSession?: { title?: string; projectPath?: string };
    prompt: string;
    personaPrompt?: string;
    unattendedPolicy?: "strict" | "degraded" | "lenient";
    timeoutMs?: number;
  }): Promise<{
    sessionId: string;
    completion: Promise<{ sessionId: string; status: string; finalText: string }>;
  }>;
}

export interface ChannelLogger {
  app(scope: string, level: string, message: string, data?: unknown): void;
}
