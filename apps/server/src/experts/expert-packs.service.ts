import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { orgExpertPacks } from '../db/schema.js';

/**
 * Module 01 组织专家库 (T51.8, FR-E-18/19, SPEC §3.4)：
 * 管理台发布组织专家/专家团「定义包」，payload 即定义文档的
 * frontmatter 字段 + 正文（SPEC §2.1/§2.2）——
 *   expert: {industry?, tags?, examples?, skills?, mcpServers?, model?,
 *            thinkingLevel?, budgetTokens?, body}
 *   team:   {members, leaderStyle, integration, budgetTokens?, body}
 * 成员经 GET /org/bootstrap 的 expertPacks[] 收到 enabled 条目的只读副本
 * （客户端 OrgService 落为定义文件：upsert by name、source=org、版本变化提示更新）。
 * 发布幂等（蓝本=org_skills）：同名同内容 → 原版本不 bump；内容变化 → version+1。
 * skills/mcpServers 仅存名称引用（SPEC §4：客户端缺失即降级，不自动安装）。
 */

export type ExpertPackKind = 'expert' | 'team';

export interface ExpertPackPayload {
  industry?: string;
  tags?: string[];
  examples?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  thinkingLevel?: string;
  budgetTokens?: number;
  members?: string[];
  leaderStyle?: 'fine' | 'coarse';
  integration?: 'moderator' | 'summary' | 'sections';
  body: string;
}

export interface ExpertPackDto {
  id: string;
  kind: ExpertPackKind;
  name: string;
  description: string;
  payload: ExpertPackPayload;
  version: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** bootstrap 交付载荷（SPEC §3.4）：[{kind, name, payload, version}]（仅 enabled）。 */
export interface ExpertPackDeliveryItem {
  kind: ExpertPackKind;
  name: string;
  payload: ExpertPackPayload;
  version: number;
}

export interface ExpertPackPublishInput {
  kind: string;
  name: string;
  description?: string;
  payload?: unknown;
}

export interface ExpertPackPublishResult {
  pack: ExpertPackDto;
  /** false = 幂等重发布（内容未变，版本不 bump） */
  changed: boolean;
}

/** 桌面端 THINKING_LEVELS 同源枚举（apps/desktop ExpertsPage）。 */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strArray = (v: unknown): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ExpertPackError(422, 'EARRAY', '该字段必须为字符串数组');
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
};

/** 键序无关的规范 JSON（幂等比较用：同内容 → 同串）。 */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export class ExpertPackService {
  // 单租户（rbac.ts 同语义）：一次部署 = 一个组织
  private static readonly ORG = 'default';

  constructor(private readonly db: NodePgDatabase<Record<string, never>>) {}

  /** 输入校验 + 归一（enum 用 text + app-level guards，见 schema.ts 顶部说明）。 */
  private normalize(input: ExpertPackPublishInput): {
    kind: ExpertPackKind;
    name: string;
    description: string;
    payload: ExpertPackPayload;
  } {
    const kind = input.kind;
    if (kind !== 'expert' && kind !== 'team') throw new ExpertPackError(422, 'EKIND', 'kind 必须为 expert 或 team');
    const name = String(input.name ?? '').trim();
    if (!name) throw new ExpertPackError(422, 'ENAME', '名称不能为空');
    if (name.length > 100) throw new ExpertPackError(422, 'ENAME', '名称过长');
    const description = String(input.description ?? '').trim();

    if (!isPlainObject(input.payload)) throw new ExpertPackError(422, 'EPAYLOAD', 'payload 必须为对象');
    const raw = input.payload;
    const body = String(raw.body ?? '').trim();
    if (!body) throw new ExpertPackError(422, 'EBODY', '正文（body=系统提示词/团长指令）不能为空');
    if (body.length > 200_000) throw new ExpertPackError(422, 'EBODY', '正文过长（≤200k 字符）');

    const payload: ExpertPackPayload = { body };

    const budgetTokens = raw.budgetTokens;
    if (budgetTokens !== undefined) {
      const n = Number(budgetTokens);
      if (!Number.isInteger(n) || n <= 0) throw new ExpertPackError(422, 'EBUDGET', 'budgetTokens 必须为正整数');
      payload.budgetTokens = n;
    }

    if (kind === 'expert') {
      // 行业分类（SPEC §2.1：行业枚举；容忍任意非空串，前端给固定枚举）
      if (raw.industry !== undefined) {
        const industry = String(raw.industry ?? '').trim();
        if (industry) payload.industry = industry;
      }
      for (const key of ['tags', 'examples', 'skills', 'mcpServers'] as const) {
        const arr = strArray(raw[key]);
        if (arr && arr.length) payload[key] = arr;
      }
      if (raw.model !== undefined) {
        const model = String(raw.model ?? '').trim();
        if (model) payload.model = model;
      }
      if (raw.thinkingLevel !== undefined) {
        const level = String(raw.thinkingLevel ?? '').trim();
        if (level && !THINKING_LEVELS.has(level)) {
          throw new ExpertPackError(422, 'ETHINKING', 'thinkingLevel 必须为 off|minimal|low|medium|high|xhigh|max');
        }
        if (level) payload.thinkingLevel = level;
      }
    } else {
      // 专家团（FR-E-14：成员 ≤6；团长风格 fine|coarse；整合策略 moderator|summary|sections）
      const members = strArray(raw.members) ?? [];
      if (!members.length) throw new ExpertPackError(422, 'EMEMBERS', 'members 至少选择一名成员专家');
      if (members.length > 6) throw new ExpertPackError(422, 'EMEMBERS', '成员专家最多 6 名');
      payload.members = members;
      const leaderStyle = raw.leaderStyle;
      if (leaderStyle !== 'fine' && leaderStyle !== 'coarse') {
        throw new ExpertPackError(422, 'ELEADER', 'leaderStyle 必须为 fine 或 coarse');
      }
      payload.leaderStyle = leaderStyle;
      const integration = raw.integration;
      if (integration !== 'moderator' && integration !== 'summary' && integration !== 'sections') {
        throw new ExpertPackError(422, 'EINTEGRATION', 'integration 必须为 moderator|summary|sections');
      }
      payload.integration = integration;
    }
    return { kind, name, description, payload };
  }

  /**
   * 幂等发布：同名存在时——
   *   规范化内容（payload+description+kind）一致 → 原样返回（版本不 bump）；
   *   有变化 → version+1 覆盖。事务内 SELECT … FOR UPDATE 串行化并发 bump，
   *   首发竞态靠 UNIQUE(org_id,name) 兜底后重试（蓝本=org_skills 发布模式）。
   */
  async publish(input: ExpertPackPublishInput, actorId: string): Promise<ExpertPackPublishResult> {
    const v = this.normalize(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(orgExpertPacks)
            .where(and(eq(orgExpertPacks.orgId, ExpertPackService.ORG), eq(orgExpertPacks.name, v.name)))
            .for('update')
            .limit(1);
          if (existing) {
            const incoming = canonicalJson({ kind: v.kind, description: v.description, payload: v.payload });
            const stored = canonicalJson({ kind: existing.kind, description: existing.description, payload: existing.payload });
            if (incoming === stored) return { pack: this.toDto(existing), changed: false };
            const [bumped] = await tx
              .update(orgExpertPacks)
              .set({
                kind: v.kind,
                description: v.description,
                payload: v.payload,
                version: existing.version + 1,
              })
              .where(eq(orgExpertPacks.id, existing.id))
              .returning();
            return { pack: this.toDto(bumped!), changed: true };
          }
          const [row] = await tx
            .insert(orgExpertPacks)
            .values({
              orgId: ExpertPackService.ORG,
              kind: v.kind,
              name: v.name,
              description: v.description,
              payload: v.payload,
              version: 1,
              createdBy: actorId,
            })
            .returning();
          return { pack: this.toDto(row!), changed: true };
        });
      } catch (err) {
        if (isUniqueViolation(err) && attempt < 2) continue; // 首发竞态：下一轮走更新分支
        throw err;
      }
    }
    throw new ExpertPackError(409, 'ECONFLICT', '发布冲突，请重试');
  }

  /** 管理台列表（系统/团队管理员）：全量含停用，每名一行=当前版本。 */
  async list(): Promise<ExpertPackDto[]> {
    const rows = await this.db.select().from(orgExpertPacks).orderBy(asc(orgExpertPacks.createdAt));
    return rows.map((r) => this.toDto(r));
  }

  async remove(id: string): Promise<ExpertPackDto> {
    const rows = await this.db.delete(orgExpertPacks).where(eq(orgExpertPacks.id, id)).returning();
    if (rows.length === 0) throw new ExpertPackError(404, 'ENOENT', '专家/专家团不存在');
    return this.toDto(rows[0]!);
  }

  /** bootstrap 交付（SPEC §3.4）：仅 enabled，{kind, name, payload, version}。 */
  async deliveryFor(): Promise<ExpertPackDeliveryItem[]> {
    const rows = await this.db
      .select()
      .from(orgExpertPacks)
      .where(eq(orgExpertPacks.enabled, true))
      .orderBy(asc(orgExpertPacks.createdAt));
    return rows.map((r) => ({
      kind: r.kind as ExpertPackKind,
      name: r.name,
      payload: r.payload as ExpertPackPayload,
      version: r.version,
    }));
  }

  private toDto(r: typeof orgExpertPacks.$inferSelect): ExpertPackDto {
    return {
      id: r.id,
      kind: r.kind as ExpertPackKind,
      name: r.name,
      description: r.description,
      payload: r.payload as ExpertPackPayload,
      version: r.version,
      enabled: r.enabled,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

export class ExpertPackError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ExpertPackError';
  }
}
