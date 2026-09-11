import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { orgKbServers } from '../db/schema.js';
import { SecretBox } from './secret-box.js';

/**
 * Module 05 知识库下发条目 (FR-KB-02/10/11, SPEC §2.2/§3.4)：
 * 管理台配置组织知识库「下发项」（知识检索 MCP 服务 / 网页端 URL），
 * 成员经 GET /org/bootstrap 的 kbServers[] 按团队 scope 收到。
 * apiKey 服务器侧 AES-256-GCM 加密静态存储（secret-box），明文仅在
 * 下发瞬间经 TLS 交给被授权成员 —— 这就是「交付」本身。
 */

export type KbKind = 'mcp' | 'web';
export type KbTransport = 'stdio' | 'http';
export type KbScope = 'all' | 'teams';

export interface KbServerDto {
  id: string;
  kind: KbKind;
  name: string;
  transport: KbTransport;
  url: string;
  description: string;
  scope: KbScope;
  teamIds: string[];
  enabled: boolean;
  keyTail: string; // 打码：尾 4 位（无 key 为 ''）
  createdBy: string | null;
  createdAt: string;
}

/** bootstrap 交付载荷（SPEC §2.2）：mcp 含明文 apiKey；web 仅 name/url。 */
export type KbDeliveryItem =
  | { id: string; kind: 'mcp'; name: string; transport: KbTransport; url: string; apiKey: string; description: string; enabled: true }
  | { id: string; kind: 'web'; name: string; url: string; enabled: true };

export interface KbUpsertInput {
  kind: string;
  name: string;
  transport?: string;
  url?: string;
  apiKey?: string;
  description?: string;
  scope?: string;
  teamIds?: string[];
  enabled?: boolean;
}

export interface KbPatchInput {
  kind?: string;
  name?: string;
  transport?: string;
  url?: string;
  apiKey?: string;
  description?: string;
  scope?: string;
  teamIds?: string[];
  enabled?: boolean;
}

export class KbServerService {
  private readonly box: SecretBox;

  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    secretBox: SecretBox,
  ) {
    this.box = secretBox;
  }

  /** 输入校验 + 归一（app-level guards，见 schema.ts 顶部说明：enum 用 text + 校验）。 */
  private normalize(input: KbUpsertInput | KbPatchInput, partial: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => { out[k] = v; };

    if (!partial || input.kind !== undefined) {
      const kind = input.kind ?? 'mcp';
      if (kind !== 'mcp' && kind !== 'web') throw new KbError(422, 'EKIND', 'kind 必须为 mcp 或 web');
      set('kind', kind);
    }
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new KbError(422, 'ENAME', '名称不能为空');
      set('name', name);
    }
    if (input.transport !== undefined) {
      const t = input.transport === '' ? undefined : input.transport;
      if (t !== undefined && t !== 'stdio' && t !== 'http') throw new KbError(422, 'ETRANSPORT', 'transport 必须为 stdio 或 http');
      set('transport', t ?? 'http');
    }
    if (input.url !== undefined) set('url', String(input.url ?? '').trim());
    if (!partial || input.url !== undefined) {
      // url 对两类条目都必填：mcp/http 为服务端点；mcp/stdio 为启动命令；web 为网页入口
      if (!String(out.url ?? input.url ?? '').trim()) throw new KbError(422, 'EURL', 'URL 不能为空');
    }
    if (input.apiKey !== undefined) set('apiKey', String(input.apiKey ?? ''));
    if (input.description !== undefined) set('description', String(input.description ?? ''));
    if (input.scope !== undefined) {
      if (input.scope !== 'all' && input.scope !== 'teams') throw new KbError(422, 'ESCOPE', 'scope 必须为 all 或 teams');
      set('scope', input.scope);
    }
    if (input.teamIds !== undefined) {
      const ids = Array.isArray(input.teamIds) ? input.teamIds.map(String).filter(Boolean) : [];
      set('teamIds', ids);
    }
    if (input.enabled !== undefined) set('enabled', Boolean(input.enabled));

    const scope = (out.scope ?? undefined) as KbScope | undefined;
    const teamIds = (out.teamIds ?? undefined) as string[] | undefined;
    if (scope === 'teams' && !(teamIds ?? []).length) {
      throw new KbError(422, 'ETEAMIDS', 'scope=teams 时至少选择一个团队');
    }
    return out;
  }

  async create(input: KbUpsertInput, actorId: string): Promise<KbServerDto> {
    const v = this.normalize(input, false);
    const kind = v.kind as KbKind;
    const apiKey = (v.apiKey as string | undefined) ?? '';
    // UNIQUE(org_id, name)：先查给出可读冲突，再靠约束兜底并发
    const dup = await this.db
      .select({ id: orgKbServers.id })
      .from(orgKbServers)
      .where(and(eq(orgKbServers.orgId, 'default'), eq(orgKbServers.name, v.name as string)))
      .limit(1);
    if (dup.length > 0) throw new KbError(409, 'ECONFLICT', '同名知识库条目已存在');
    const [row] = await this.db
      .insert(orgKbServers)
      .values({
        orgId: 'default',
        kind,
        name: v.name as string,
        transport: (v.transport as KbTransport | undefined) ?? 'http',
        url: v.url as string,
        apiKeyEnc: apiKey ? this.box.encrypt(apiKey) : null,
        description: (v.description as string | undefined) ?? '',
        scope: (v.scope as KbScope | undefined) ?? 'all',
        teamIds: (v.teamIds as string[] | undefined) ?? [],
        enabled: (v.enabled as boolean | undefined) ?? true,
        createdBy: actorId,
      })
      .returning();
    return this.toDto(row!);
  }

  /** 管理台列表（sys_admin）：绝不含明文 key，仅尾 4 位。 */
  async list(): Promise<KbServerDto[]> {
    const rows = await this.db.select().from(orgKbServers).orderBy(asc(orgKbServers.createdAt));
    return rows.map((r) => this.toDto(r));
  }

  async update(id: string, patch: KbPatchInput): Promise<KbServerDto> {
    const [row] = await this.db.select().from(orgKbServers).where(eq(orgKbServers.id, id)).limit(1);
    if (!row) throw new KbError(404, 'ENOENT', '知识库条目不存在');
    const v = this.normalize(patch, true);
    if (v.name !== undefined && v.name !== row.name) {
      const dup = await this.db
        .select({ id: orgKbServers.id })
        .from(orgKbServers)
        .where(and(eq(orgKbServers.orgId, row.orgId), eq(orgKbServers.name, v.name as string)))
        .limit(1);
      if (dup.length > 0) throw new KbError(409, 'ECONFLICT', '同名知识库条目已存在');
    }
    const set: Record<string, unknown> = {};
    for (const k of ['kind', 'name', 'transport', 'url', 'description', 'scope', 'teamIds', 'enabled'] as const) {
      if (v[k] !== undefined) set[k] = v[k];
    }
    if (v.apiKey !== undefined) {
      const apiKey = v.apiKey as string;
      set.apiKeyEnc = apiKey ? this.box.encrypt(apiKey) : null; // 传空串 = 清除 key
    }
    const [updated] = await this.db.update(orgKbServers).set(set).where(eq(orgKbServers.id, id)).returning();
    return this.toDto(updated!);
  }

  async remove(id: string): Promise<KbServerDto> {
    const rows = await this.db.delete(orgKbServers).where(eq(orgKbServers.id, id)).returning();
    if (rows.length === 0) throw new KbError(404, 'ENOENT', '知识库条目不存在');
    return this.toDto(rows[0]!);
  }

  /**
   * bootstrap 交付（SPEC §2.2）：请求者组织内 enabled=true 的条目，
   * scope=all 或 teamIds 命中请求者团队。mcp 项解密出明文 apiKey
   * （经 TLS 交给被授权成员=交付本身）；web 项仅 name/url。
   */
  async deliveryFor(teamId: string | null): Promise<KbDeliveryItem[]> {
    const rows = await this.db.select().from(orgKbServers).where(eq(orgKbServers.enabled, true));
    const out: KbDeliveryItem[] = [];
    for (const r of rows) {
      if (r.scope === 'teams' && !(r.teamIds as string[]).includes(teamId ?? '')) continue;
      if (r.kind === 'web') {
        out.push({ id: r.id, kind: 'web', name: r.name, url: r.url, enabled: true });
      } else {
        out.push({
          id: r.id,
          kind: 'mcp',
          name: r.name,
          transport: r.transport as KbTransport,
          url: r.url,
          apiKey: r.apiKeyEnc ? this.box.decrypt(r.apiKeyEnc) : '',
          description: r.description,
          enabled: true,
        });
      }
    }
    return out;
  }

  private toDto(r: typeof orgKbServers.$inferSelect): KbServerDto {
    return {
      id: r.id,
      kind: r.kind as KbKind,
      name: r.name,
      transport: r.transport as KbTransport,
      url: r.url,
      description: r.description,
      scope: r.scope as KbScope,
      teamIds: r.teamIds as string[],
      enabled: r.enabled,
      keyTail: this.box.safeTail(r.apiKeyEnc),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

export class KbError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'KbError';
  }
}
