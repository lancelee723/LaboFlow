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
