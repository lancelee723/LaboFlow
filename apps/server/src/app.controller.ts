import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Req, HttpException, HttpCode, Module, SetMetadata } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import websocketPlugin from '@fastify/websocket';
import { AuthGuard } from './auth/auth.guard.js';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { FastifyRequest, FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrate } from './db/migrate.js';
import { AuthService, AuthError } from './auth/auth.service.js';
import { GatewayService } from './gateway/gateway.service.js';
import { QuotaError } from './gateway/quota-error.js';
import { quotaPolicies, teams as teamsTable, providerChannels } from './db/schema.js';
import { validateTeamPolicy } from './quota/quota-rules.js';
import { eq, sql } from 'drizzle-orm';
import { can, type Role } from './teams/rbac.js';
import { WorkspaceService, WorkspaceError } from './workspaces/workspace.service.js';
import { canWorkspace } from './workspaces/workspace-rules.js';
import { DeliverableService, OrgLibraryService, DeliverableError } from './workspaces/library.service.js';
import { KbServerService, KbError, type KbPatchInput } from './kb/kb.service.js';
import { SecretBox } from './kb/secret-box.js';
import { ExpertPackService, ExpertPackError } from './experts/expert-packs.service.js';
import { SpaceService, SpaceError } from './spaces/spaces.service.js';
import { SERVER_VERSION } from './index.js';

/**
 * T2.1 server skeleton: one Nest module wiring the P2 services over Fastify.
 * Controllers are thin (auth/parse/guard); logic lives in the services so the
 * unit + integration tests exercise the same code paths the HTTP layer does.
 */

export interface ServerDeps {
  db: ReturnType<typeof drizzle>;
  auth: AuthService;
  gateway: GatewayService;
  workspaces: WorkspaceService;
  deliverables: DeliverableService;
  library: OrgLibraryService;
  kb: KbServerService;
  expertPacks: ExpertPackService;
  spaces: SpaceService;
}

type Actor = { userId: string; role: Role; teamId: string | null };

/** The bootstrap preHandler verifies the Bearer token and stashes __auth. */
function requireActor(req: FastifyRequest): Actor {
  const actor = (req as FastifyRequest & { __auth?: Actor }).__auth;
  if (!actor) throw new HttpException('未登录或令牌无效', 401);
  return actor;
}

function requireSysAdmin(req: FastifyRequest): boolean {
  return requireActor(req).role === 'sys_admin';
}

@Controller()
class CoreController {
  constructor(private readonly deps: ServerDeps) {}

  @Get('healthz')
  @SetMetadata('isPublic', true)
  healthz() {
    return { ok: true, version: SERVER_VERSION, phase: 'P2-beta' };
  }

  /** Friendly landing for browsers: this is an API server, not a website. */
  @Get()
  @SetMetadata('isPublic', true)
  index() {
    return {
      name: 'LaboFlow Server',
      version: SERVER_VERSION,
      phase: 'P2-beta',
      hint: 'This is an API server — connect from the LaboFlow desktop app (Settings → Organization). API base is the same origin; try /healthz.',
      endpoints: ['/healthz', '/auth/login', '/org/bootstrap'],
    };
  }

  // ----- T2.2 auth -----
  @Post('auth/login')
  @HttpCode(200)
  @SetMetadata('isPublic', true)
  async login(@Body() body: { username?: string; password?: string }) {
    try {
      const r = await this.deps.auth.login(String(body.username ?? ''), String(body.password ?? ''));
      return {
        userId: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName,
        role: r.user.role,
        teamId: r.user.teamId,
        mustChangePassword: r.mustChangePassword,
        tokens: r.tokens,
      };
    } catch (err) {
      if (err instanceof AuthError) throw new HttpException(err.message, err.code === 'ELOCKED' ? 423 : 401);
      throw err;
    }
  }

  @Post('auth/change-password')
  @HttpCode(200)
  async changePassword(@Req() req: FastifyRequest, @Body() body: { currentPassword?: string; newPassword?: string }) {
    const actor = requireActor(req);
    try {
      const tokens = await this.deps.auth.changePassword(actor.userId, String(body.currentPassword ?? ''), String(body.newPassword ?? ''));
      return { ok: true, tokens };
    } catch (err) {
      if (err instanceof AuthError) throw new HttpException(err.message, err.code === 'WEAK_PASSWORD' ? 422 : 401);
      throw err;
    }
  }

  @Post('users')
  @HttpCode(200)
  async createUser(@Req() req: FastifyRequest, @Body() body: { username?: string; displayName?: string; password?: string; role?: Role; teamId?: string }) {
    const actor = requireActor(req);
    if (!can('team.manageUsers', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined, targetTeamId: body.teamId })) {
      throw new HttpException('无权创建用户', 403);
    }
    try {
      const user = await this.deps.auth.createUser(actor.userId, {
        username: String(body.username ?? ''),
        displayName: String(body.displayName ?? body.username ?? ''),
        password: String(body.password ?? ''),
        role: body.role ?? 'member',
        teamId: body.teamId ?? null,
      });
      return user;
    } catch (err) {
      if (err instanceof AuthError) throw new HttpException(err.message, err.code === 'ECONFLICT' ? 409 : err.code === 'EFORBIDDEN' ? 403 : 422);
      throw err;
    }
  }

  @Post('users/:id/reset-password')
  @HttpCode(200)
  async resetPassword(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { newPassword?: string }) {
    const actor = requireActor(req);
    try {
      const temp = await this.deps.auth.adminResetPassword(actor.userId, id, String(body.newPassword ?? ''));
      return { ok: true, temporaryPassword: temp, mustChangePassword: true };
    } catch (err) {
      if (err instanceof AuthError) throw new HttpException(err.message, err.code === 'EFORBIDDEN' ? 403 : 422);
      throw err;
    }
  }

  // ----- T2.5 quota admin -----
  @Put('quota/policies')
  async upsertPolicy(@Req() req: FastifyRequest, @Body() body: { scope?: string; teamId?: string; subject?: string; subjectId?: string; kind?: string; limitValue?: number; period?: string }) {
    const actor = requireActor(req);
    const action = body.scope === 'team' ? 'quota.team' : 'quota.system';
    if (!can(action as never, { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined, targetTeamId: body.teamId })) {
      throw new HttpException('无权设置该配额策略', 403);
    }
    const candidate = {
      scope: (body.scope ?? 'system') as 'system' | 'team',
      teamId: body.teamId ?? null,
      subject: (body.subject ?? 'team') as 'team' | 'user',
      subjectId: body.subjectId ?? null,
      kind: (body.kind ?? 'tokens') as 'tokens' | 'sessions',
      limitValue: Number(body.limitValue ?? 0),
      period: (body.period ?? 'monthly') as 'daily' | 'weekly' | 'monthly',
    };
    if (candidate.scope === 'team') {
      const systemPolicies = (await this.deps.db.select().from(quotaPolicies)) as unknown as Parameters<typeof validateTeamPolicy>[1];
      const v = validateTeamPolicy(candidate, systemPolicies);
      if (!v.ok) throw new HttpException(v.reason ?? '策略冲突', 422);
    }
    const inserted = (await this.deps.db.insert(quotaPolicies).values(candidate).returning())[0];
    await this.deps.auth.audit(actor.userId, 'quota.policy.create', candidate.kind, { ...candidate });
    return inserted;
  }

  /**
   * Live quota view (PRD 4.2.4): strictest effective limits for this actor ×
   * current-period usage from the atomic quota counters the gateway bumps.
   * Team-scoped subjects appear only for team members.
   */
  @Get('quota/remaining')
  async remaining(@Req() req: FastifyRequest) {
    const actor = requireActor(req);
    const { quotaPolicies, quotaCounters } = await import('./db/schema.js');
    const rules = await import('./quota/quota-rules.js');
    const policies = (await this.deps.db.select().from(quotaPolicies)) as unknown as Parameters<typeof rules.effectiveLimits>[0];
    const teamId = actor.teamId;
    // System policies apply to every user, so teamless users still get limits.
    const limits = rules.effectiveLimits(policies, {
      teamId: teamId ?? "",
      userId: actor.userId,
    });
    const now = new Date();
    const counters = (await this.deps.db.select().from(quotaCounters)) as Array<{
      subjectType: string;
      subjectId: string;
      periodKind: string;
      periodKey: string;
      sessions: number;
      tokensIn: number;
      tokensOut: number;
    }>;
    const used = (subjectType: 'team' | 'user', subjectId: string, period: 'daily' | 'weekly' | 'monthly') => {
      const key = rules.periodKey(period, now);
      const row = counters.find(
        (c) => c.subjectType === subjectType && c.subjectId === subjectId && c.periodKind === period && c.periodKey === key,
      );
      return { tokens: (row?.tokensIn ?? 0) + (row?.tokensOut ?? 0), sessions: row?.sessions ?? 0 };
    };
    const entries = limits.map((limit) => {
      const team = teamId ? used('team', teamId, limit.period) : null;
      const self = used('user', actor.userId, limit.period);
      return {
        kind: limit.kind,
        period: limit.period,
        limit: limit.limit,
        teamUsed: team ? (limit.kind === 'tokens' ? team.tokens : team.sessions) : null,
        selfUsed: limit.kind === 'tokens' ? self.tokens : self.sessions,
        resetAt: rules.periodEnd(limit.period, now).toISOString(),
      };
    });
    return { ok: true, entries, generatedAt: now.toISOString() };
  }

  // ----- T2.4 admin: channels -----
  @Post('gateway/channels')
  @HttpCode(200)
  async createChannel(@Req() req: FastifyRequest, @Body() body: { name?: string; protocol?: string; baseUrl?: string; apiKey?: string; models?: string[] }) {
    const actor = requireActor(req);
    if (!can('channel.manage', { actorRole: actor.role })) throw new HttpException('仅系统管理员可管理渠道', 403);
    const inserted = (
      await this.deps.db
        .insert(providerChannels)
        .values({
          name: String(body.name ?? 'channel'),
          protocol: body.protocol === 'anthropic' ? 'anthropic' : 'openai',
          baseUrl: String(body.baseUrl ?? ''),
          apiKeyEnc: Buffer.from(String(body.apiKey ?? ''), 'utf8').toString('base64'),
          models: body.models ?? [],
        })
        .returning()
    )[0];
    await this.deps.auth.audit(actor.userId, 'channel.create', body.name ?? '', {});
    return inserted;
  }

  // ----- T2.4 gateway endpoints (dual protocol) -----
  @Post('gateway/openai/v1/chat/completions')
  @HttpCode(200)
  @SetMetadata('isPublic', true) // gateway authenticates via virtual keys
  async openaiProxy(@Req() req: FastifyRequest, @Body() body: Record<string, unknown>) {
    return this.proxy(req, body, 'openai');
  }

  @Post('gateway/anthropic/v1/messages')
  @HttpCode(200)
  @SetMetadata('isPublic', true)
  async anthropicProxy(@Req() req: FastifyRequest, @Body() body: Record<string, unknown>) {
    return this.proxy(req, body, 'anthropic');
  }

  // ----- T2.15 client usage calibration source -----
  @Get('api/usage/mine')
  async usageMine(@Req() req: FastifyRequest & { query: Record<string, string> }) {
    const actor = requireActor(req);
    const since = (req.query as { since?: string }).since;
    const rows = (
      await this.deps.db.execute(sql`
        SELECT date(ts) AS day, model, SUM(tokens_in)::int AS tokens_in, SUM(tokens_out)::int AS tokens_out, COUNT(*)::int AS calls
        FROM usage_logs WHERE user_id = ${actor.userId} ${since ? sql`AND ts > ${since}::timestamptz` : sql``}
        GROUP BY date(ts), model ORDER BY day DESC LIMIT 400`)
    ).rows;
    return rows;
  }

  // ----- T2.9 admin console API (sys_admin only) -----
  @Get('admin/overview')
  async adminOverview(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const count = async (table: string): Promise<number> => {
      const rows = (await this.deps.db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM ${table}`))).rows as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    };
    const usage7d = (await this.deps.db.execute(sql.raw(
      "SELECT COALESCE(SUM(tokens_in + tokens_out),0)::bigint AS tokens, COUNT(*)::int AS calls FROM usage_logs WHERE ts > now() - interval '7 days'",
    ))).rows[0] as { tokens: string; calls: number };
    const activeUsers7d = (await this.deps.db.execute(sql.raw(
      "SELECT COUNT(DISTINCT user_id)::int AS n FROM usage_logs WHERE ts > now() - interval '7 days' AND user_id IS NOT NULL",
    ))).rows[0] as { n: number };
    return {
      users: await count('users'),
      teams: await count('teams'),
      workspaces: await count('workspaces'),
      sharedSessions: await count('shared_sessions'),
      deliverables: await count('deliverables'),
      orgSkills: await count('org_skills'),
      usage7d: { tokens: Number(usage7d?.tokens ?? 0), calls: usage7d?.calls ?? 0, activeUsers: activeUsers7d?.n ?? 0 },
    };
  }

  @Get('admin/users')
  async adminListUsers(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const { users } = await import('./db/schema.js');
    return (await this.deps.db.select({
      id: users.id, username: users.username, displayName: users.displayName,
      role: users.role, teamId: users.teamId, disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword, createdAt: users.createdAt,
    }).from(users));
  }

  @Post('admin/users/:id/disable')
  async adminDisableUser(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { disabled?: boolean }) {
    const actor = requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const { users } = await import('./db/schema.js');
    await this.deps.db.update(users).set({ disabledAt: body.disabled === false ? null : new Date() }).where(eq(users.id, id));
    await this.deps.auth.audit(actor.userId, body.disabled === false ? 'user.enable' : 'user.disable', id, {});
    return { ok: true };
  }

  @Get('admin/teams')
  async adminListTeams(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const { teams } = await import('./db/schema.js');
    return this.deps.db.select().from(teams);
  }

  @Get('admin/workspaces')
  async adminListWorkspaces(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const { workspaces } = await import('./db/schema.js');
    return this.deps.db.select().from(workspaces);
  }

  @Get('admin/channels')
  async adminListChannels(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const rows = await this.deps.db.select().from(providerChannels);
    return rows.map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, baseUrl: c.baseUrl, models: c.models, health: c.health, keyTail: '***' }));
  }

  @Get('admin/quota/policies')
  async adminListPolicies(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    return this.deps.db.select().from(quotaPolicies);
  }

  @Get('admin/audit')
  async adminAudit(@Req() req: FastifyRequest & { query: Record<string, string> }) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    const limit = Math.min(500, Number((req.query as { limit?: string }).limit ?? 100));
    const { auditLogs } = await import('./db/schema.js');
    return this.deps.db.select().from(auditLogs).orderBy(sql`${auditLogs.id} DESC`).limit(limit);
  }

  // ----- T2.10 organization bootstrap (login delivery pack) -----
  @Get('org/bootstrap')
  async orgBootstrap(@Req() req: FastifyRequest) {
    const actor = requireActor(req);
    const { users, teams: teamsT, workspaces: wsT, workspaceMembers, providerChannels, quotaPolicies, orgSkills } = await import('./db/schema.js');
    const user = (await this.deps.db.select().from(users).where(eq(users.id, actor.userId)).limit(1))[0];
    if (!user) throw new HttpException('用户不存在', 404);
    // my workspaces (via membership) with my perm
    const myMemberships = await this.deps.db
      .select({ workspaceId: workspaceMembers.workspaceId, perm: workspaceMembers.perm })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, actor.userId));
    const workspaces = [];
    for (const m of myMemberships) {
      const [ws] = await this.deps.db.select().from(wsT).where(eq(wsT.id, m.workspaceId)).limit(1);
      if (ws) workspaces.push({ id: ws.id, name: ws.name, teamId: ws.teamId, perm: m.perm });
    }
    // org channels: model configs the user may use (assign all or their team)
    const channels = (await this.deps.db.select().from(providerChannels)) as Array<{ id: string; name: string; protocol: string; baseUrl: string; models: unknown; assign: { mode?: string; ids?: string[] } }>;
    const myChannels = channels
      .filter((c) => c.assign?.mode === 'all' || (actor.teamId && (c.assign?.ids ?? []).includes(actor.teamId)))
      .map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, baseUrl: c.baseUrl, models: c.models }));
    // gateway URL advertised so the client can register the org provider
    const host = String(req.headers.host ?? 'localhost');
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
    const gatewayUrl = `${proto}://${host}/gateway`;
    // issue a fresh virtual key for this login delivery
    const vkey = await this.deps.auth.issueVirtualKey(actor.userId);
    // policy floor: strictest policy touching this user's team
    const policies = (await this.deps.db.select().from(quotaPolicies)) as unknown as Parameters<typeof import('./quota/quota-rules.js').effectiveLimits>[0];
    const policyFloor = actor.teamId
      ? (await import('./quota/quota-rules.js')).effectiveLimits(policies, { teamId: actor.teamId, userId: actor.userId })
      : [];
    const skills = await this.deps.library.catalog();
    let teamName: string | null = null;
    if (actor.teamId) {
      const [tm] = await this.deps.db.select().from(teamsT).where(eq(teamsT.id, actor.teamId)).limit(1);
      teamName = tm?.name ?? null;
    }
    // Module 05 知识库下发（FR-KB-02）：enabled 的条目按团队 scope 过滤后交付；
    // mcp 项含明文 apiKey（TLS 下=交付本身），web 项仅 name/url。
    const kbServers = await this.deps.kb.deliveryFor(actor.teamId);
    // Module 01 组织专家库下发（FR-E-18）：enabled 的专家/专家团定义包
    // [{kind, name, payload, version}]；客户端落为只读副本（source=org）。
    const expertPacks = await this.deps.expertPacks.deliveryFor();
    return {
      org: { name: 'LaboFlow Org', teamId: actor.teamId, teamName },
      me: { userId: actor.userId, username: user.username, displayName: user.displayName, role: actor.role },
      workspaces,
      orgChannels: myChannels,
      gateway: { url: gatewayUrl, virtualKey: vkey.plain },
      policyFloor,
      orgSkills: skills,
      kbServers,
      expertPacks,
    };
  }

  // ----- Module 05 知识库下发条目 (FR-KB-02/10/11) -----
  @Post('org/kb-servers')
  @HttpCode(200)
  async createKbServer(@Req() req: FastifyRequest, @Body() body: {
    kind?: string; name?: string; transport?: string; url?: string; apiKey?: string;
    description?: string; scope?: string; teamIds?: string[];
  }) {
    const actor = requireActor(req);
    if (!can('kb.manage', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可管理知识库条目', 403);
    }
    try {
      const dto = await this.deps.kb.create({
        kind: String(body.kind ?? 'mcp'),
        name: String(body.name ?? ''),
        transport: body.transport,
        url: body.url,
        apiKey: body.apiKey,
        description: body.description,
        scope: body.scope,
        teamIds: body.teamIds,
      }, actor.userId);
      await this.deps.auth.audit(actor.userId, 'kb.create', dto.name, { kind: dto.kind, scope: dto.scope, teamIds: dto.teamIds });
      return dto;
    } catch (err) {
      if (err instanceof KbError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** 管理台列表（仅 sys_admin）：不含明文 key，keyTail=尾 4 位。 */
  @Get('org/kb-servers')
  async listKbServers(@Req() req: FastifyRequest) {
    requireActor(req);
    if (!requireSysAdmin(req)) throw new HttpException('仅系统管理员', 403);
    return this.deps.kb.list();
  }

  @Patch('org/kb-servers/:id')
  @HttpCode(200)
  async updateKbServer(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: KbPatchInput) {
    const actor = requireActor(req);
    if (!can('kb.manage', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可管理知识库条目', 403);
    }
    try {
      const dto = await this.deps.kb.update(id, body);
      await this.deps.auth.audit(actor.userId, 'kb.update', dto.name, {
        id: dto.id,
        fields: Object.keys(body ?? {}).filter((k) => k !== 'apiKey'), // key 明文不入审计
        apiKeyRotated: Boolean(body?.apiKey),
      });
      return dto;
    } catch (err) {
      if (err instanceof KbError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  @Delete('org/kb-servers/:id')
  async deleteKbServer(@Req() req: FastifyRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    if (!can('kb.manage', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可管理知识库条目', 403);
    }
    try {
      const removed = await this.deps.kb.remove(id);
      await this.deps.auth.audit(actor.userId, 'kb.delete', removed.name, { id });
      return { ok: true };
    } catch (err) {
      if (err instanceof KbError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  // ----- Module 01 组织专家库 (T51.8, FR-E-18/19)：发布/版本/bootstrap 下发 -----
  /** 幂等发布：同名同内容 → 版本不变；内容变化 → version+1（SPEC §3.4 蓝本=org_skills）。 */
  @Post('org/expert-packs')
  @HttpCode(200)
  async publishExpertPack(@Req() req: FastifyRequest, @Body() body: {
    kind?: string; name?: string; description?: string; payload?: unknown;
  }) {
    const actor = requireActor(req);
    if (!can('expertPacks.manage', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可发布组织专家/专家团', 403);
    }
    try {
      const r = await this.deps.expertPacks.publish({
        kind: String(body.kind ?? ''),
        name: String(body.name ?? ''),
        description: body.description,
        payload: body.payload,
      }, actor.userId);
      await this.deps.auth.audit(actor.userId, 'expertPack.publish', r.pack.name, {
        id: r.pack.id,
        kind: r.pack.kind,
        version: r.pack.version,
        changed: r.changed, // false=幂等重发布（无内容变化）
      });
      return r.pack;
    } catch (err) {
      if (err instanceof ExpertPackError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** 管理台列表（系统/团队管理员）：全量含停用，每名一行=当前版本。 */
  @Get('org/expert-packs')
  async listExpertPacks(@Req() req: FastifyRequest) {
    const actor = requireActor(req);
    if (!can('expertPacks.manage', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可查看组织专家库', 403);
    }
    return this.deps.expertPacks.list();
  }

  @Delete('org/expert-packs/:id')
  async deleteExpertPack(@Req() req: FastifyRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    if (!can('expertPacks.manage', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可删除组织专家/专家团', 403);
    }
    try {
      const removed = await this.deps.expertPacks.remove(id);
      await this.deps.auth.audit(actor.userId, 'expertPack.delete', removed.name, { id });
      return { ok: true };
    } catch (err) {
      if (err instanceof ExpertPackError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  // ----- Module 02 团队空间 (T52.1-3)：权限判定在 SpaceService（space-rules 纯函数） -----
  /** 统一错误映射：SpaceError.status + 可读 message + 机器可读 code（409 EVERSION/EANCHOR 等）。 */
  private space<T>(p: Promise<T>): Promise<T> {
    return p.catch((err: unknown) => {
      if (err instanceof SpaceError) throw new HttpException({ code: err.code, message: err.message }, err.status);
      throw err;
    });
  }

  /** 团队管理员以上可建空间（镜像 workspace.create 语义）。 */
  @Post('spaces')
  @HttpCode(200)
  async createSpace(@Req() req: FastifyRequest, @Body() body: { teamId?: string; name?: string; description?: string }) {
    const actor = requireActor(req);
    const teamId = body.teamId ? String(body.teamId) : actor.teamId;
    if (!can('workspace.create', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined, targetTeamId: teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可创建空间', 403);
    }
    return this.space(this.deps.spaces.createSpace({ userId: actor.userId, teamId: actor.teamId }, {
      teamId: String(teamId ?? ''), name: String(body.name ?? ''), description: body.description,
    }));
  }

  @Get('spaces')
  async listMySpaces(@Req() req: FastifyRequest) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.listMySpaces(actor.userId));
  }

  @Patch('spaces/:id')
  async updateSpace(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { name?: string; archived?: boolean }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.updateSpace(id, { userId: actor.userId, teamId: actor.teamId }, body));
  }

  @Post('spaces/:id/members')
  @HttpCode(200)
  async addSpaceMember(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { userId?: string; perm?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.addMember(id, { userId: actor.userId, teamId: actor.teamId }, {
      userId: String(body.userId ?? ''), perm: String(body.perm ?? 'viewer'),
    }));
  }

  @Get('spaces/:id/members')
  async listSpaceMembers(@Req() req: FastifyRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.listMembers(id, { userId: actor.userId, teamId: actor.teamId }));
  }

  @Patch('spaces/:id/members/:uid')
  async updateSpaceMember(@Req() req: FastifyRequest, @Param('id') id: string, @Param('uid') uid: string, @Body() body: { perm?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.updateMember(id, { userId: actor.userId, teamId: actor.teamId }, uid, {
      perm: String(body.perm ?? 'viewer'),
    }));
  }

  @Delete('spaces/:id/members/:uid')
  async removeSpaceMember(@Req() req: FastifyRequest, @Param('id') id: string, @Param('uid') uid: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.removeMember(id, { userId: actor.userId, teamId: actor.teamId }, uid));
  }

  @Post('spaces/:id/nodes')
  @HttpCode(200)
  async createSpaceNode(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { parentId?: string | null; type?: string; name?: string; sortKey?: number }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.createNode(id, { userId: actor.userId, teamId: actor.teamId }, {
      parentId: body.parentId ?? null, type: String(body.type ?? ''), name: String(body.name ?? ''), sortKey: body.sortKey,
    }));
  }

  @Get('spaces/:id/tree')
  async spaceTree(@Req() req: FastifyRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.tree(id, { userId: actor.userId, teamId: actor.teamId }));
  }

  @Patch('spaces/:id/nodes/:nid')
  async updateSpaceNode(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Body() body: { name?: string; parentId?: string | null; sortKey?: number }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.updateNode(id, { userId: actor.userId, teamId: actor.teamId }, nid, body));
  }

  /** 软删 → 回收站（子树随父隐藏）。 */
  @Delete('spaces/:id/nodes/:nid')
  async deleteSpaceNode(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.deleteNode(id, { userId: actor.userId, teamId: actor.teamId }, nid));
  }

  @Post('spaces/:id/nodes/:nid/restore')
  @HttpCode(200)
  async restoreSpaceNode(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.restoreNode(id, { userId: actor.userId, teamId: actor.teamId }, nid));
  }

  /** 节点级覆盖（T52.2）：none=显式 deny（隐藏）；manager 专用。 */
  @Patch('spaces/:id/nodes/:nid/overrides/:subjectId')
  async setNodeOverride(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Param('subjectId') subjectId: string, @Body() body: { perm?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.setNodeOverride(id, { userId: actor.userId, teamId: actor.teamId }, nid, subjectId, {
      perm: String(body.perm ?? ''),
    }));
  }

  @Delete('spaces/:id/nodes/:nid/overrides/:subjectId')
  async clearNodeOverride(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Param('subjectId') subjectId: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.clearNodeOverride(id, { userId: actor.userId, teamId: actor.teamId }, nid, subjectId));
  }

  @Get('spaces/:id/nodes/:nid/doc')
  async getSpaceDoc(@Req() req: FastifyRequest & { query: Record<string, string> }, @Param('id') id: string, @Param('nid') nid: string) {
    const actor = requireActor(req);
    const v = (req.query as { version?: string }).version;
    const version = v !== undefined && v !== '' ? Number(v) : undefined;
    return this.space(this.deps.spaces.getDoc(id, { userId: actor.userId, teamId: actor.teamId }, nid, Number.isFinite(version) ? version : undefined));
  }

  /** 乐观锁保存：{content, baseVersion}；冲突 409 EVERSION。 */
  @Put('spaces/:id/nodes/:nid/doc')
  async putSpaceDoc(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Body() body: { content?: string; baseVersion?: number; source?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.saveDoc(id, { userId: actor.userId, teamId: actor.teamId }, nid, {
      content: String(body.content ?? ''), baseVersion: Number(body.baseVersion ?? 0), source: body.source,
    }));
  }

  @Get('spaces/:id/nodes/:nid/comments')
  async listComments(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.listComments(id, { userId: actor.userId, teamId: actor.teamId }, nid));
  }

  @Post('spaces/:id/nodes/:nid/comments')
  @HttpCode(200)
  async createComment(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Body() body: { body?: string; anchor?: unknown }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.createComment(id, { userId: actor.userId, teamId: actor.teamId }, nid, {
      body: String(body.body ?? ''), anchor: body.anchor,
    }));
  }

  @Post('spaces/:id/nodes/:nid/comments/:cid/reply')
  @HttpCode(200)
  async replyComment(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Param('cid') cid: string, @Body() body: { body?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.replyComment(id, { userId: actor.userId, teamId: actor.teamId }, nid, cid, {
      body: String(body.body ?? ''),
    }));
  }

  @Post('spaces/:id/nodes/:nid/comments/:cid/resolve')
  @HttpCode(200)
  async resolveComment(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Param('cid') cid: string, @Body() body: { status?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.resolveComment(id, { userId: actor.userId, teamId: actor.teamId }, nid, cid, {
      status: body.status ?? 'resolved',
    }));
  }

  @Get('spaces/:id/nodes/:nid/revisions')
  async listRevisions(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.listRevisions(id, { userId: actor.userId, teamId: actor.teamId }, nid));
  }

  @Post('spaces/:id/nodes/:nid/revisions')
  @HttpCode(200)
  async createRevision(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Body() body: {
    anchor?: unknown; originalText?: string; revisedText?: string; rationale?: string; producedBy?: string; model?: string;
  }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.createRevision(id, { userId: actor.userId, teamId: actor.teamId }, nid, {
      anchor: body.anchor, originalText: String(body.originalText ?? ''), revisedText: String(body.revisedText ?? ''),
      rationale: body.rationale, producedBy: body.producedBy, model: body.model,
    }));
  }

  /** 接受=事务内重读正文做锚定替换（原文不匹配 409 EANCHOR），提交 source='ai-accept' 新版本。 */
  @Post('spaces/:id/nodes/:nid/revisions/:rid/decide')
  @HttpCode(200)
  async decideRevision(@Req() req: FastifyRequest, @Param('id') id: string, @Param('nid') nid: string, @Param('rid') rid: string, @Body() body: { decision?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.decideRevision(id, { userId: actor.userId, teamId: actor.teamId }, nid, rid, {
      decision: String(body.decision ?? ''),
    }));
  }

  /** 推流增量拉取（WS hub 复用同一游标语义），ordered asc、capped 200。 */
  @Get('spaces/:id/events')
  async spaceEvents(@Req() req: FastifyRequest & { query: Record<string, string> }, @Param('id') id: string) {
    const actor = requireActor(req);
    const since = Number((req.query as { since?: string }).since ?? -1);
    return this.space(this.deps.spaces.listEvents(id, { userId: actor.userId, teamId: actor.teamId }, Number.isFinite(since) ? since : -1));
  }

  /** 邀请链接：token 明文仅此一次返回，服务端只存 sha256（SPEC §4）。 */
  @Post('spaces/:id/invites')
  @HttpCode(200)
  async createInvite(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { perm?: string; access?: string; expiresInDays?: number; maxUses?: number | null }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.createInvite(id, { userId: actor.userId, teamId: actor.teamId }, body));
  }

  @Post('invites/redeem')
  @HttpCode(200)
  async redeemInvite(@Req() req: FastifyRequest, @Body() body: { token?: string }) {
    const actor = requireActor(req);
    return this.space(this.deps.spaces.redeemInvite({ userId: actor.userId, teamId: actor.teamId }, { token: String(body.token ?? '') }));
  }

  // ----- T2.6 workspaces & shared sessions -----
  @Post('workspaces')
  async createWorkspace(@Req() req: FastifyRequest, @Body() body: { teamId?: string; name?: string; description?: string }) {
    const actor = requireActor(req);
    if (!can('workspace.create', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined, targetTeamId: body.teamId })) {
      throw new HttpException('无权创建工作区', 403);
    }
    return this.deps.workspaces.createWorkspace(String(body.teamId), String(body.name ?? 'workspace'), actor.userId, String(body.description ?? ''));
  }

  @Post('workspaces/:id/members')
  async addMember(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { userId?: string; perm?: string }) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'manage');
    await this.deps.workspaces.addMember(id, String(body.userId), (body.perm ?? 'viewer') as never);
    return { ok: true };
  }

  @Post('workspaces/:id/sessions')
  async createShared(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { title?: string }) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'shareSession');
    return this.deps.workspaces.createSharedSession(id, actor.userId, String(body.title ?? '共享会话'));
  }

  /** P4 共享工作区: 会话列表（含持锁人显示名与 lastSeq，供旁观/增量同步）。 */
  @Get('workspaces/:id/sessions')
  async listShared(@Req() req: FastifyRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'view');
    return this.deps.workspaces.listShared(id);
  }

  @Post('workspaces/:id/sessions/:sid/lock')
  async lock(@Req() req: FastifyRequest, @Param('id') id: string, @Param('sid') sid: string) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'speak');
    const r = await this.deps.workspaces.acquire(sid, actor.userId);
    if (r.granted) return { granted: true };
    return r;
  }

  @Post('workspaces/:id/sessions/:sid/heartbeat')
  async heartbeatRoute(@Req() req: FastifyRequest, @Param('sid') sid: string) {
    const actor = requireActor(req);
    const ok = await this.deps.workspaces.refreshHeartbeat(sid, actor.userId);
    if (!ok) throw new HttpException('锁已被他人持有', 409);
    return { ok: true };
  }

  @Post('workspaces/:id/sessions/:sid/release')
  async release(@Req() req: FastifyRequest, @Param('sid') sid: string) {
    const actor = requireActor(req);
    const ok = await this.deps.workspaces.release(sid, actor.userId);
    return { ok };
  }

  @Post('workspaces/:id/sessions/:sid/entries')
  async appendEntry(@Req() req: FastifyRequest, @Param('id') id: string, @Param('sid') sid: string, @Body() body: { entry?: unknown; seq?: number }) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'speak');
    // 回合制：发言前必须持锁（锁内发言不受排队影响；服务端强制）
    try {
      const r = await this.deps.workspaces.appendEntry(sid, actor.userId, body.entry, body.seq);
      return r;
    } catch (err) {
      if (err instanceof WorkspaceError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  @Get('workspaces/:id/sessions/:sid/entries')
  async pullEntries(@Req() req: FastifyRequest & { query: Record<string, string> }, @Param('id') id: string, @Param('sid') sid: string) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'view');
    const since = Number((req.query as { since?: string }).since ?? -1);
    return this.deps.workspaces.entriesSince(sid, Number.isFinite(since) ? since : -1);
  }

  // ----- T2.7 deliverables -----
  @Post('workspaces/:id/deliverables')
  async uploadDeliverable(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: { path?: string; title?: string; contentBase64?: string; source?: string; sessionId?: string }) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'upload');
    try {
      const d = await this.deps.deliverables.upload({
        workspaceId: id,
        path: String(body.path ?? 'file.bin'),
        title: body.title,
        content: Buffer.from(String(body.contentBase64 ?? ''), 'base64'),
        uploaderId: actor.userId,
        source: body.source === 'session' ? 'session' : 'upload',
        sessionId: body.sessionId ?? null,
      });
      return d;
    } catch (err) {
      if (err instanceof DeliverableError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  @Get('workspaces/:id/deliverables')
  async listDeliverables(@Req() req: FastifyRequest, @Param('id') id: string) {
    const actor = requireActor(req);
    await this.deps.workspaces.assertCan(id, actor.userId, 'view');
    return this.deps.deliverables.list(id);
  }

  @Get('deliverables/:did/download')
  async downloadDeliverable(@Req() req: FastifyRequest & { query: Record<string, string> }, @Param('did') did: string) {
    const actor = requireActor(req);
    const version = (req.query as { version?: string }).version ? Number((req.query as { version?: string }).version) : undefined;
    const r = await this.deps.deliverables.download(did, version);
    if (!r) throw new HttpException('版本不存在', 404);
    return { contentBase64: r.content.toString('base64'), sha256: r.sha256, versionNo: r.versionNo };
  }

  @Post('deliverables/:did/rollback')
  async rollbackDeliverable(@Req() req: FastifyRequest, @Param('did') did: string, @Body() body: { toVersion?: number }) {
    const actor = requireActor(req);
    const d = await this.deps.deliverables.get(did);
    if (!d) throw new HttpException('交付物不存在', 404);
    await this.deps.workspaces.assertCan(d.workspaceId, actor.userId, 'upload');
    try {
      return await this.deps.deliverables.rollback(did, Number(body.toVersion), actor.userId);
    } catch (err) {
      if (err instanceof DeliverableError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  // ----- T2.8 org skill library -----
  @Post('library/skills')
  async publishSkill(@Req() req: FastifyRequest, @Body() body: { name?: string; version?: string; manifest?: Record<string, unknown>; packageBase64?: string }) {
    const actor = requireActor(req);
    if (!can('library.publish', { actorRole: actor.role, actorTeamId: actor.teamId ?? undefined })) {
      throw new HttpException('仅系统/团队管理员可发布组织 Skill', 403);
    }
    const dto = await this.deps.library.publish({
      name: String(body.name ?? 'skill'),
      version: String(body.version ?? '1.0.0'),
      manifest: body.manifest ?? {},
      packageContent: Buffer.from(String(body.packageBase64 ?? ''), 'base64'),
      publisherId: actor.userId,
    });
    await this.deps.auth.audit(actor.userId, 'library.publish', body.name ?? '', { version: body.version });
    return dto;
  }

  @Get('library/skills')
  async skillCatalog(@Req() req: FastifyRequest) {
    requireActor(req);
    return this.deps.library.catalog();
  }

  @Get('library/skills/:name/download')
  async downloadSkill(@Req() req: FastifyRequest & { query: Record<string, string> }, @Param('name') name: string) {
    requireActor(req);
    const version = (req.query as { version?: string }).version;
    const r = await this.deps.library.download(name, version);
    if (!r) throw new HttpException('Skill 不存在', 404);
    return { packageBase64: r.content.toString('base64'), version: r.version };
  }

  private async proxy(req: FastifyRequest, body: Record<string, unknown>, protocol: 'openai' | 'anthropic') {
    const header = req.headers.authorization ?? '';
    const vkey = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      const r = await this.deps.gateway.proxy(body as { model: string }, vkey, protocol);
      return r.body;
    } catch (err) {
      if (err instanceof QuotaError) {
        throw new HttpException({ code: err.code, message: err.message, headers: err.headers }, err.status);
      }
      throw err;
    }
  }

  @Delete('auth/sessions/:id')
  async logout(@Req() req: FastifyRequest, @Param('id') id: string) {
    void req;
    void id;
    return { ok: true }; // token revocation list lands with T2.9 hardening
  }

  @Get('teams')
  async listTeams(@Req() req: FastifyRequest) {
    const actor = requireActor(req);
    if (!can('team.create', { actorRole: actor.role })) throw new HttpException('无权查看团队列表', 403);
    return (await this.deps.db.select().from(teamsTable));
  }

  @Post('teams')
  @HttpCode(200)
  async createTeam(@Req() req: FastifyRequest, @Body() body: { name?: string }) {
    const actor = requireActor(req);
    if (!can('team.create', { actorRole: actor.role })) throw new HttpException('仅系统管理员可创建团队', 403);
    const inserted = (await this.deps.db.insert(teamsTable).values({ name: String(body.name ?? 'team') }).returning())[0];
    await this.deps.auth.audit(actor.userId, 'team.create', body.name ?? '', {});
    return inserted;
  }
}

/** Boot the API (used by main.ts and integration tests). */
export async function bootstrap(options: {
  databaseUrl: string;
  jwtSecret: string;
  port?: number;
  /** injectable upstream for gateway tests */
  upstreamFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** local volume root for deliverables / org skills */
  storageDir?: string;
  /** AES-256-GCM master key material for secrets at rest (kb servers); falls back to SERVER_ENCRYPTION_KEY, then derives from jwtSecret */
  serverEncryptionKey?: string;
}): Promise<{ app: INestApplication; deps: ServerDeps; port: number }> {
  const pool = new Pool({ connectionString: options.databaseUrl, max: 5 });
  const db = drizzle(pool);
  await migrate(db);
  const auth = new AuthService(db, options.jwtSecret);
  const deps: ServerDeps = {
    db,
    auth,
    gateway: new GatewayService({ db, upstreamFetch: options.upstreamFetch }),
    workspaces: new WorkspaceService(db),
    deliverables: new DeliverableService(db, options.storageDir ?? './storage'),
    library: new OrgLibraryService(db, options.storageDir ?? './storage'),
    kb: new KbServerService(db, SecretBox.forServer(
      options.serverEncryptionKey ?? process.env.SERVER_ENCRYPTION_KEY,
      options.jwtSecret,
    )),
    expertPacks: new ExpertPackService(db),
    spaces: new SpaceService(db, (actorId, action, target, detail) => auth.audit(actorId, action, target, detail)),
  };

  @Controller()
  class WiredController extends CoreController {
    constructor() {
      super(deps);
    }
  }

  @Module({
    controllers: [WiredController],
    providers: [{ provide: APP_GUARD, useFactory: () => new AuthGuard(deps.auth, new Reflector()) }],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, new (await import('@nestjs/platform-fastify')).FastifyAdapter());
  app.enableShutdownHooks();
  // T2.6 WS push stream: /ws/:workspaceId/:sessionId?token=<jwt>
  // frames → client: {type: 'entry.appended'|'lock.acquired'|'lock.released', ...}
  // frames → server: {type: 'heartbeat'}
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(websocketPlugin);
  fastify.get('/ws/:workspaceId/:sessionId', { websocket: true }, (conn: { close: (code: number, reason: string) => void; send: (s: string) => void; on: (ev: string, cb: (raw?: Buffer) => void) => void }, req: { params?: Record<string, string>; query?: Record<string, string>; __actor?: string }) => {
    const params = req.params ?? {};
    const query = req.query ?? {};
    void (async () => {
      try {
        const payload = await deps.auth.verifyToken(query.token ?? '');
        if (payload.typ !== 'access') throw new Error('bad token');
        const perm = await deps.workspaces.memberPerm(params.workspaceId as string, payload.sub);
        if (!perm) throw new Error('no access');
      } catch {
        conn.close(4001, 'unauthorized');
        return;
      }
      const off = deps.workspaces.onPush((event) => {
        if (event.sessionId !== (params.sessionId as string)) return;
        conn.send(JSON.stringify(event));
      });
      conn.on('message', (raw?: Buffer) => {
        try {
          const msg = JSON.parse(String(raw)) as { type?: string };
          if (msg.type === 'heartbeat' && params.sessionId) {
            void deps.workspaces.refreshHeartbeat(params.sessionId, req.__actor ?? query.userId ?? '');
          }
        } catch { /* ignore malformed frames */ }
      });
      conn.on('close', () => off());
    })();
  });
  const port = options.port ?? 0; // 0 = ephemeral (tests)
  await app.listen(port, '127.0.0.1');
  const address = await app.getUrl();
  const resolvedPort = Number(new URL(address).port);
  return { app: app as unknown as INestApplication, deps, port: resolvedPort };
}

