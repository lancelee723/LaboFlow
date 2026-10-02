/**
 * Compatibility facade for the shared public type surface.
 *
 * Keep consumers on the shared types module while domain modules evolve independently.
 */
export * from "./types/common.js";
export * from "./types/plans.js";
export * from "./types/models.js";
export * from "./types/permissions.js";
export * from "./types/messages.js";
export * from "./types/sessions.js";
export * from "./types/agent.js";
export * from "./types/workspace.js";
export * from "./types/providers.js";
export * from "./types/settings.js";
export * from "./types/plugins.js";
export * from "./types/capabilities.js";
export * from "./types/marketplace.js";
export * from "./types/composer.js";
export * from "./types/platform.js";
export * from "./types/workpanel.js";
export * from "./types/filesystem.js";
export * from "./types/speech.js";
export * from "./types/remote-host.js";
export * from "./types/config-sync.js";
export * from "./types/live-voice.js";

// --- Organization (PRD 4.1.12 / FR-S-01) -----------------------------------

export type OrgRole = "sys_admin" | "team_admin" | "member";

export type OrgProfile = {
  userId: string;
  username: string;
  displayName?: string;
  role?: OrgRole | string;
};

export type OrgSessionInfo = {
  /** Stable key: `${serverUrl}|${username}`. */
  key: string;
  serverUrl: string;
  username: string;
  displayName?: string;
  role?: string;
  orgName?: string;
  /** Disabled accounts stay stored but cannot be current. */
  enabled?: boolean;
};

export type OrgStatus = {
  connected: boolean;
  /** "expired" = tokens exist but the server rejected them; re-login needed. */
  state: "disconnected" | "connected" | "expired";
  serverUrl?: string;
  username?: string;
  displayName?: string;
  role?: string;
  orgName?: string;
  teamName?: string;
  workspaceCount?: number;
  mustChangePassword?: boolean;
  error?: string;
  /** Every stored org session (multi-org support) and which one is current. */
  orgs?: OrgSessionInfo[];
  currentKey?: string;
  /** Workspaces from the latest bootstrap (Phase 4 shared workspaces). */
  workspaces?: OrgWorkspaceInfo[];
};

export type OrgBootstrap = {
  org: { name?: string; teamId?: string | null; teamName?: string | null };
  me: OrgProfile;
  workspaces: Array<Record<string, unknown>>;
  orgChannels: Array<Record<string, unknown>>;
  gateway?: { url?: string; virtualKey?: string };
};

// --- Org quota view (PRD 4.2.4, P3 quota panel) -----------------------------

export type OrgQuotaEntry = {
  kind: "tokens" | "sessions" | string;
  period: "daily" | "weekly" | "monthly" | string;
  limit: number;
  teamUsed?: number | null;
  selfUsed: number;
  resetAt?: string;
};

export type OrgWorkspacePerm = "viewer" | "contributor" | "manager";

export type OrgWorkspaceInfo = {
  id: string;
  name: string;
  teamId?: string | null;
  perm: OrgWorkspacePerm | string;
};

export type OrgSharedSession = {
  id: string;
  title: string;
  ownerId?: string | null;
  ownerName?: string | null;
  lockUserId?: string | null;
  lockHolderName?: string | null;
  lastSeq: number;
  createdAt?: string;
};

export type OrgSharedEntry = {
  seq: number;
  entry: { kind?: string; text?: string } & Record<string, unknown>;
  authorId?: string | null;
};

export type OrgWsFrame = {
  sessionId: string;
  type: "entry.appended" | "lock.acquired" | "lock.released" | string;
  seq?: number;
  entry?: OrgSharedEntry["entry"];
  userId?: string;
  mine?: boolean;
  reason?: string;
};

export type OrgDeliverable = {
  id: string;
  path: string;
  title: string;
  currentVersion: number;
  source?: string;
  uploaderId?: string | null;
  createdAt?: string;
};

export type OrgQuotaRemaining = {
  ok: boolean;
  entries: OrgQuotaEntry[];
  generatedAt?: string;
};

/** Module 01: expert / expert-team shared renderer-main types. */

export interface ExpertInvocation {
  /** Session that requested the dispatch (receives the completion card). */
  sessionId?: string;
  expertId: string;
  task: string;
}

export interface TeamPlanSubtask {
  expert: string;
  brief: string;
  dependsOn: number[];
}

export interface TeamPlan {
  subtasks: TeamPlanSubtask[];
  riskNotes?: string;
}

export type ExpertTeamProgressType =
  | "plan"
  | "dispatch"
  | "member"
  | "integrated"
  | "failed";

export interface ExpertTeamProgress {
  runId: string;
  sessionId?: string;
  type: ExpertTeamProgressType;
  payload: Record<string, unknown>;
}

/** Module 05: knowledge-base delivery + web-URL entries. */

export interface KbServerDelivery {
  kind: "mcp" | "web";
  name: string;
  /** mcp only */
  transport?: "stdio" | "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  apiKey?: string;
  description?: string;
  enabled?: boolean;
}

export interface KbUrlEntry {
  id: string;
  name: string;
  url: string;
  source: "user" | "org";
  orgId?: string;
}

/** Module 04: IM channels (feishu / wecom intelligent bots / wechat_mp 公众号中继). */

export type ChannelProvider = "feishu" | "wecom" | "wechat_mp";

export type ChannelAccountScope = "p2p" | "group" | "both";

/**
 * One configured IM channel. Credentials ride along as `credentials` only
 * inside the main process (injected just before `connect`); IPC list/save
 * responses must strip them — the renderer never sees secret material.
 */
export interface ChannelAccount {
  id: string;
  provider: ChannelProvider;
  name: string;
  /** Host secrets key that holds the credential blob (future migration v15). */
  secretRef?: string;
  scope: ChannelAccountScope;
  /** Platform identities (feishu open_id / wecom userid) allowed to command. */
  allowlist: string[];
  enabled: boolean;
  /** Main-process only; plaintext over IPC save, never returned. */
  credentials?: Record<string, string>;
}

export type ChannelState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface DiagInfo {
  kind: "network" | "credential" | "permission" | "publish" | "unknown";
  message: string;
  rawCode?: string;
}

/** Account row as returned over IPC — credentials are never included. */
export interface ChannelAccountView {
  id: string;
  provider: ChannelProvider;
  name: string;
  scope: ChannelAccountScope;
  allowlist: string[];
  enabled: boolean;
  hasCredentials: boolean;
  state: ChannelState;
  diag?: DiagInfo;
  lastConnectedAt?: number;
}

/** Result of the channels/test IPC (connection health check). */
export interface ChannelTestResult {
  ok: boolean;
  diag?: DiagInfo;
}

/** State change event pushed to the renderer (`IPC.event.channelState`). */
export interface ChannelStateEvent {
  accountId: string;
  provider: ChannelProvider;
  state: ChannelState;
  diag?: DiagInfo;
  lastConnectedAt?: number;
}

/** Save input accepted over IPC; empty credential values mean "unchanged". */
export interface ChannelAccountSaveInput {
  id?: string;
  provider: ChannelProvider;
  name?: string;
  scope?: ChannelAccountScope;
  allowlist?: string[];
  enabled?: boolean;
  credentials?: Record<string, string>;
}

export interface InboundMessage {
  /** ChannelAccount.id the message arrived on. */
  channelId: string;
  provider: ChannelProvider;
  /** Platform sender identity (feishu open_id / wecom userid). */
  senderRef: string;
  /** Platform chat identity used as the reply address. */
  chatRef: string;
  chatType: "p2p" | "group";
  text: string;
  raw: unknown;
  receivedAt: number;
}

export interface OutboundPayload {
  replyText: string;
  statusCard?: {
    title: string;
    status: string;
    detail?: string;
  };
}

export interface ChannelCapabilities {
  maxTextBytes: number;
  fileMaxBytes: number;
  streaming: boolean;
  card: boolean;
  replyWindowMs?: number;
}

/** Module 02: Team Spaces (T52.1-3 server slice; SPEC §2/§3.2). */

export type SpacePerm = "viewer" | "contributor" | "manager";

export type SpaceNodeType = "folder" | "md" | "csv" | "html" | "file";

export type SpaceDocSource = "human" | "ai-accept" | "agent-direct";

/** 文档树节点（GET /spaces/:id/tree 平铺输出，父先于子）。perm = 有效档位（含节点覆盖后的）。 */
export interface SpaceNode {
  id: string;
  spaceId: string;
  parentId: string | null;
  type: SpaceNodeType;
  name: string;
  sortKey: number;
  perm: SpacePerm | "none";
  createdBy: string | null;
  updatedBy: string | null;
  updatedAt: string;
  createdAt: string;
}

/** MD/CSV 正文（服务端权威 + 版本链）。version=0 表示尚无版本（content 为空）。 */
export interface SpaceDoc {
  nodeId: string;
  version: number;
  content: string;
  sha256: string | null;
  authorId: string | null;
  source: SpaceDocSource | null;
  createdAt: string | null;
  currentVersion: number;
}

export interface SpaceComment {
  id: string;
  nodeId: string;
  /** SPEC §2 锚定 {kind, paraIndex, textPrefix, textHash} / html block id / csv (row,col)。 */
  anchor: Record<string, unknown> | null;
  authorId: string;
  body: string;
  parentId: string | null;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
}

export interface RevisionSuggestion {
  id: string;
  nodeId: string;
  anchor: Record<string, unknown> | null;
  originalText: string;
  revisedText: string;
  rationale: string;
  status: "pending" | "accepted" | "rejected";
  requestedBy: string;
  producedBy: "user" | "agent";
  model: string | null;
  acceptedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** space_events 行（WS hub 推流帧与活动流共用；断线重连按 since=seq 增量拉取）。 */
export interface SpaceEventPayload {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
}

// --- Module 02: Team Spaces client slice (T52.4-11; SPEC §3.5 IPC) ---
// SpaceNode / SpaceDoc / SpaceComment / RevisionSuggestion land with the
// server slice above; everything here is the renderer-facing contract on top.

/** 空间列表行（GET /spaces）：myPerm = 当前用户在该空间的档位。 */
export interface SpaceDto {
  id: string;
  teamId: string | null;
  name: string;
  description: string;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  myPerm: SpacePerm;
}

export interface SpaceMemberDto {
  userId: string;
  username: string;
  displayName: string | null;
  perm: SpacePerm;
  invitedBy: string | null;
  createdAt: string;
}

/** SPEC §2 锚定模型。MD=段落文本锚；CSV=(row,col)；HTML=块 id（Yjs 相对路径）。 */
export type SpaceTextAnchor = {
  kind: "text";
  /** 0-based line-block index into the markdown source. */
  paraIndex: number;
  textPrefix: string;
  /** sha256 hex of the exact selected text. */
  textHash: string;
};
export type SpaceCsvAnchor = { kind: "csv"; row: number; col: number };
export type SpaceHtmlAnchor = { kind: "html"; blockId: string };
export type SpaceAnchor = SpaceTextAnchor | SpaceCsvAnchor | SpaceHtmlAnchor;

/** 平铺树行（父先于子，GET /spaces/:id/tree）挂上客户端构建的子节点。 */
export interface SpaceTreeEntry extends SpaceNode {
  children: SpaceTreeEntry[];
}

/** 渲染层收到的空间事件帧（IPC.event.spaceEvent；spaceId 由客户端标注）。 */
export interface SpaceEventFrame extends SpaceEventPayload {
  spaceId: string;
}

/** 接受修订建议的返回：appliedVersion 标记接受后提交的正文版本。 */
export type RevisionDecideResult = RevisionSuggestion & {
  appliedVersion?: number;
};

// --- Module 01: Org expert packs (T51.8; SPEC §3.4, FR-E-18/19) ---
// 服务端发布的组织专家/专家团定义包，经 GET /org/bootstrap 的 expertPacks[]
// 下发；客户端 OrgService 落为只读定义文件（upsert by name，source=org，
// 版本变化 UI 提示更新）。payload 即定义文档 frontmatter+正文（SPEC §2.1/2.2）。

export type OrgExpertPackKind = "expert" | "team";

/** expert: {industry?, tags?, examples?, skills?, mcpServers?, model?, thinkingLevel?, budgetTokens?, body}；team: {members, leaderStyle, integration, budgetTokens?, body}。skills/mcpServers 仅存名称引用（缺失即降级，不自动安装）。 */
export interface OrgExpertPackPayload {
  industry?: string;
  tags?: string[];
  examples?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  thinkingLevel?: string;
  budgetTokens?: number;
  members?: string[];
  leaderStyle?: "fine" | "coarse";
  integration?: "moderator" | "summary" | "sections";
  body: string;
}

/** bootstrap 交付项（SPEC §3.4：[{kind, name, payload, version}]，仅 enabled）。 */
export interface OrgExpertPack {
  kind: OrgExpertPackKind;
  name: string;
  payload: OrgExpertPackPayload;
  version: number;
}

/** 管理台列表行（GET /org/expert-packs）：含说明/启停/发布者元信息。 */
export interface OrgExpertPackDto extends OrgExpertPack {
  id: string;
  description: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}
