import {
  pgTable, uuid, text, boolean, timestamp, integer, bigint, jsonb, real, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * SPEC §5.5 server data model (P2 scope: T2.1-T2.5). Enum-ish columns are
 * text + app-level guards (drizzle pg enums complicate idempotent migrations).
 */

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  adminUserId: uuid('admin_user_id'), // set after the admin user exists (每团队唯一管理员)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  // sys_admin | team_admin | member (PRD 4.2.2)
  role: text('role').notNull().default('member'),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const providerChannels = pgTable('provider_channels', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // openai | anthropic (ADR-5 双协议)
  protocol: text('protocol').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: text('api_key_enc').notNull(), // 服务器侧加密存储（P2 首版：环境密钥 AES；密钥不出服务端）
  models: jsonb('models').notNull().default([]),
  assign: jsonb('assign').notNull().default({ mode: 'all' }), // {mode: all|teams|users, ids: []}
  health: text('health').notNull().default('ok'), // ok | degraded
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const virtualKeys = pgTable('virtual_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(), // sha256(vk_xxx) — 明文只在签发瞬间
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const quotaPolicies = pgTable('quota_policies', {
  id: uuid('id').defaultRandom().primaryKey(),
  scope: text('scope').notNull(), // system | team
  teamId: uuid('team_id'),
  subject: text('subject').notNull(), // team | user
  subjectId: uuid('subject_id'),
  kind: text('kind').notNull(), // sessions | tokens
  limitValue: bigint('limit_value', { mode: 'number' }).notNull(),
  period: text('period').notNull(), // daily | weekly | monthly
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const quotaCounters = pgTable(
  'quota_counters',
  {
    subjectType: text('subject_type').notNull(), // team | user
    subjectId: uuid('subject_id').notNull(),
    periodKind: text('period_kind').notNull(), // daily | weekly | monthly
    periodKey: text('period_key').notNull(), // 2026-09-06 | 2026-W36 | 2026-09
    sessions: integer('sessions').notNull().default(0),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subjectType, t.subjectId, t.periodKind, t.periodKey] })],
);

export const usageLogs = pgTable(
  'usage_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id'),
    teamId: uuid('team_id'),
    channelId: uuid('channel_id'),
    model: text('model'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    status: integer('status').notNull().default(200),
  },
  (t) => [index('idx_usage_logs_ts').on(t.ts)],
);

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(), // login | user.create | quota.update | gateway.call …
  target: text('target').notNull().default(''),
  detail: jsonb('detail').notNull().default({}),
});

export type User = typeof users.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type QuotaPolicy = typeof quotaPolicies.$inferSelect;


// ---------------------------------------------------------------------------
// T2.6/T2.7/T2.8: workspaces, shared sessions, deliverables, org library
// ---------------------------------------------------------------------------
export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    perm: text('perm').notNull().default('viewer'), // viewer | contributor | manager
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const sharedSessions = pgTable('shared_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  ownerId: uuid('owner_id'),
  title: text('title').notNull(),
  meta: jsonb('meta').notNull().default({}),
  lockUserId: uuid('lock_user_id'),
  lockHeartbeatAt: timestamp('lock_heartbeat_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sharedSessionEntries = pgTable(
  'shared_session_entries',
  {
    sessionId: uuid('session_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    entry: jsonb('entry').notNull(),
    authorId: uuid('author_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const deliverables = pgTable(
  'deliverables',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    path: text('path').notNull(),
    title: text('title').notNull(),
    currentVersion: integer('current_version').notNull().default(0),
    source: text('source').notNull().default('upload'), // upload | session
    sessionId: uuid('session_id'),
    uploaderId: uuid('uploader_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uniq_deliverable_path').on(t.workspaceId, t.path)],
);

export const deliverableVersions = pgTable(
  'deliverable_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deliverableId: uuid('deliverable_id').notNull(),
    versionNo: integer('version_no').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uniq_deliverable_version').on(t.deliverableId, t.versionNo)],
);

export const orgSkills = pgTable(
  'org_skills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    manifest: jsonb('manifest').notNull().default({}),
    storageKey: text('storage_key').notNull(),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uniq_org_skill_version').on(t.name, t.version)],
);


// ---------------------------------------------------------------------------
// Module 05 知识库接入 (FR-KB-02/10/11, SPEC §2.2): 组织知识库下发条目
// ---------------------------------------------------------------------------
export const orgKbServers = pgTable(
  'org_kb_servers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: text('org_id').notNull().default('default'), // 单租户：一次部署 = 一个组织（rbac.ts 同语义）
    kind: text('kind').notNull(), // mcp（知识检索 MCP 服务） | web（内嵌浏览网页端）
    name: text('name').notNull(),
    transport: text('transport').notNull().default('http'), // stdio | http（仅 kind=mcp；stdio 时 url 存启动命令）
    url: text('url').notNull().default(''), // mcp: <server>/mcp 端点（stdio=命令行）；web: 网页端入口
    apiKeyEnc: text('api_key_enc'), // 服务器侧加密存储（AES-256-GCM，密钥见 kb/secret-box.ts）；web 无 key
    description: text('description').notNull().default(''),
    scope: text('scope').notNull().default('all'), // all | teams（teamIds 命中的团队可见）
    teamIds: jsonb('team_ids').notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uniq_org_kb_server_name').on(t.orgId, t.name)],
);

export type OrgKbServer = typeof orgKbServers.$inferSelect;


// ---------------------------------------------------------------------------
// Module 02 团队空间 (T52.1-3, SPEC §2)：spaces / 节点树 / 文档版本 / 评论 /
// 修订建议 / 事件推流 / 邀请链接。enum-ish 列沿用 text + app-level guards。
// ---------------------------------------------------------------------------

export const spaces = pgTable('spaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id').notNull(),
    userId: uuid('user_id').notNull(),
    perm: text('perm').notNull().default('viewer'), // viewer | contributor | manager
    invitedBy: uuid('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] })],
);

export const spaceNodes = pgTable('space_nodes', {
  id: uuid('id').defaultRandom().primaryKey(),
  spaceId: uuid('space_id').notNull(),
  parentId: uuid('parent_id'), // 根节点为 NULL（自引用 FK 在迁移里加，schema 端不做循环引用）
  type: text('type').notNull(), // folder | md | csv | html | file
  name: text('name').notNull(),
  sortKey: integer('sort_key').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // 回收站=软删
  deletedBy: uuid('deleted_by'),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 节点级权限覆盖（subject = user 或 team id）；含显式 none 档（隐藏节点）。 */
export const spaceNodeOverrides = pgTable(
  'space_node_overrides',
  {
    nodeId: uuid('node_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    perm: text('perm').notNull(), // viewer | contributor | manager | none
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.subjectId] })],
);

export const spaceDocs = pgTable('space_docs', {
  nodeId: uuid('node_id').primaryKey(), // md/csv 节点（html 走 y-websocket 快照，file 走卷存储）
  currentVersion: integer('current_version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const spaceDocVersions = pgTable(
  'space_doc_versions',
  {
    nodeId: uuid('node_id').notNull(),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    authorId: uuid('author_id'),
    source: text('source').notNull().default('human'), // human | ai-accept | agent-direct
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.version] })],
);

export const comments = pgTable('comments', {
  id: uuid('id').defaultRandom().primaryKey(),
  nodeId: uuid('node_id').notNull(),
  anchor: jsonb('anchor'), // SPEC §2 锚定 {kind, paraIndex, textPrefix, textHash} / html block id / csv (row,col)
  authorId: uuid('author_id').notNull(),
  body: text('body').notNull(),
  parentId: uuid('parent_id'), // 线程回复
  status: text('status').notNull().default('open'), // open | resolved
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const revisionSuggestions = pgTable('revision_suggestions', {
  id: uuid('id').defaultRandom().primaryKey(),
  nodeId: uuid('node_id').notNull(),
  anchor: jsonb('anchor'),
  originalText: text('original_text').notNull(),
  revisedText: text('revised_text').notNull(),
  rationale: text('rationale').notNull().default(''),
  status: text('status').notNull().default('pending'), // pending | accepted | rejected
  requestedBy: uuid('requested_by').notNull(),
  producedBy: text('produced_by').notNull().default('user'), // user | agent
  model: text('model'),
  acceptedBy: uuid('accepted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

/** 推流与活动流共用。per-space seq：composite PK + 事务内 MAX(seq)+1 自增。 */
export const spaceEvents = pgTable(
  'space_events',
  {
    spaceId: uuid('space_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(), // space.* | node.* | doc.version | comment.* | revision.* | member.* | invite.*
    payload: jsonb('payload').notNull().default({}),
    actorId: uuid('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.seq] })],
);


// ---------------------------------------------------------------------------
// Module 01 组织专家库 (T51.8, FR-E-18/19, SPEC §3.4)：org_expert_packs。
// 管理台发布组织专家/专家团定义包（payload=定义文档 frontmatter+正文，SPEC
// §2.1/2.2），成员经 GET /org/bootstrap 的 expertPacks[] 收到 enabled 的只读
// 副本（客户端 upsert by name, source=org；版本变化 UI 提示更新，FR-E-19）。
// 发布幂等（蓝本=org_skills）：同名同内容 → 原版本不 bump；内容变化 → version+1。
// ---------------------------------------------------------------------------

export const orgExpertPacks = pgTable(
  'org_expert_packs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: text('org_id').notNull().default('default'), // 单租户：一次部署 = 一个组织（rbac.ts 同语义）
    kind: text('kind').notNull(), // expert（专家）| team（专家团）
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    payload: jsonb('payload').notNull().default({}), // expert: {industry?,tags?,examples?,skills?,mcpServers?,model?,thinkingLevel?,budgetTokens?,body}；team: {members,leaderStyle,integration,budgetTokens?,body}
    version: integer('version').notNull().default(1), // 首发为 1；重发布同内容幂等不 bump，内容变化 +1
    enabled: boolean('enabled').notNull().default(true), // 停用则不下发
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uniq_org_expert_pack_name').on(t.orgId, t.name)],
);

export type OrgExpertPack = typeof orgExpertPacks.$inferSelect;

export const inviteLinks = pgTable('invite_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  spaceId: uuid('space_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(), // sha256(token)——明文只在创建瞬间返回一次
  perm: text('perm').notNull().default('viewer'),
  access: text('access').notNull().default('apply'), // apply | view
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});


// ---------------------------------------------------------------------------
// Module 04 微信公众号中继 (T54.7-9, FR-IM-11/12/13, SPEC §2.2/§3.4)：
// wechat_mp_bots = 公众号凭证 + 桌面绑定（app_secret/EncodingAESKey 经
// SecretBox AES-256-GCM 静态加密，表只存密文）；wechat_mp_pending = 离线暂存
// （≤24h 清理、轮询取走即删；在线走服务端内存热队列不落库）。
// ---------------------------------------------------------------------------

export const wechatMpBots = pgTable(
  'wechat_mp_bots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: text('org_id').notNull().default('default'), // 单租户：一次部署 = 一个组织（rbac.ts 同语义）
    name: text('name').notNull(),
    appId: text('app_id').notNull(), // 公众号 AppID（回调 XML ToUserName 匹配键）
    appSecretEnc: text('app_secret_enc').notNull(), // AES-256-GCM 密文（kb/secret-box.ts）
    encodingAesKeyEnc: text('encoding_aes_key_enc'), // 安全模式 AESKey 密文；NULL=明文模式
    token: text('token').notNull(), // 回调验签令牌（验签材料，非机密，原文存储）
    allowUserIds: jsonb('allow_user_ids').notNull().default([]), // 绑定接收/发送的桌面用户
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uniq_wechat_mp_bot_app').on(t.orgId, t.appId)],
);

export type WechatMpBot = typeof wechatMpBots.$inferSelect;

export const wechatMpPending = pgTable(
  'wechat_mp_pending',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => wechatMpBots.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(), // {botId, appId, fromUser, msgType, content, msgId, createTime, receivedAt}（元数据，无附件密文体）
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_wechat_mp_pending_bot').on(t.botId, t.createdAt)],
);
