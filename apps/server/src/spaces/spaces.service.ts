import { and, asc, desc, eq, gt, ilike, inArray, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  comments, inviteLinks, revisionSuggestions, spaceDocVersions, spaceDocs,
  spaceEvents, spaceFileVersions, spaceMembers, spaceNodeOverrides, spaceNodes,
  spaceNotifications, spaces, users,
} from '../db/schema.js';
import {
  canSpace, effectivePerm, isNodePerm, isSpacePerm,
  type NodePerm, type SpaceAction, type SpacePerm,
} from './space-rules.js';

/**
 * Module 02 团队空间服务端（T52.1-3，SPEC §2/§3.1/§4）：
 * - 空间/成员/节点树/文档版本链/评论/修订建议/事件推流/邀请链接。
 * - 权限：space_members 档位被 space_node_overrides 覆盖（'none'=显式隐藏），
 *   判定统一走 space-rules.ts 纯函数；none 档与非成员一律 404 伪装（SPEC §4）。
 * - 每个变更都写 space_events（per-space seq，composite PK + MAX(seq)+1），
 *   供未来的 WS hub 按 since 增量拉取——本模块不建 WS（另一切片负责）。
 * - 组织协作范围管控（SPEC org_settings.collab_scope）：当前 schema 无组织设置
 *   表/列，redeemInvite 处的门禁暂不生效（见验收报告）。
 */

/** MD/CSV 文档版本链滚动窗口（SPEC §2：20 版滚动可配）。 */
export const SPACE_VERSIONS_KEEP = 20;
/** file 上限沿用交付物约束（PRD FR-TC-02②：单文件 ≤200MB）。 */
export const MAX_SPACE_FILE_SIZE = 200 * 1024 * 1024;

export interface SpaceActor {
  userId: string;
  teamId: string | null;
}

export type AuditFn = (
  actorId: string | null, action: string, target: string, detail: Record<string, unknown>,
) => Promise<void>;

type Tx = Parameters<Parameters<NodePgDatabase<Record<string, never>>['transaction']>[0]>[0];

const NODE_TYPES = ['folder', 'md', 'csv', 'html', 'file'] as const;
type NodeType = (typeof NODE_TYPES)[number];
const DOC_TYPES: NodeType[] = ['md', 'csv'];

export class SpaceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'SpaceError';
  }
}

type SpaceRow = typeof spaces.$inferSelect;
type NodeRow = typeof spaceNodes.$inferSelect;

export class SpaceService {
  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly audit: AuditFn,
    /** 卷存储根（file 节点内容）；缺省时 file 上传/下载不可用。 */
    private readonly storageDir?: string,
  ) {}

  // ============================ 事件（ONE mechanism，WS hub 复用） ============================

  /** per-space seq：MAX(seq)+1 单条 INSERT，PK 冲突（并发）小概率重试。 */
  private async recordEvent(
    exec: Tx, spaceId: string, type: string, payload: Record<string, unknown>, actorId: string | null,
  ): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      const res = await exec.execute(sql`
        INSERT INTO space_events (space_id, seq, type, payload, actor_id)
        VALUES (${spaceId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM space_events WHERE space_id = ${spaceId}),
                ${type}, ${JSON.stringify(payload)}::jsonb, ${actorId})
        ON CONFLICT (space_id, seq) DO NOTHING
        RETURNING seq`);
      const row = (res.rows ?? [])[0] as { seq: string | number } | undefined;
      const seq = Number(row?.seq ?? 0);
      if (seq > 0) return seq;
      if (attempt >= 4) throw new SpaceError(500, 'ESEQ', '事件序号分配失败（并发冲突）');
    }
  }

  /** 非事务路径的便捷封装。 */
  private async emit(spaceId: string, type: string, payload: Record<string, unknown>, actorId: string | null): Promise<void> {
    await this.recordEvent(this.db as unknown as Tx, spaceId, type, payload, actorId);
  }

  // ============================ 空间 ============================

  async createSpace(actor: SpaceActor, input: { teamId: string; name: string; description?: string }): Promise<{ id: string }> {
    const name = String(input.name ?? '').trim();
    if (!name) throw new SpaceError(422, 'ENAME', '空间名称不能为空');
    if (!input.teamId) throw new SpaceError(422, 'ETEAM', 'teamId 不能为空');
    const [space] = await this.db
      .insert(spaces)
      .values({ teamId: input.teamId, name, description: String(input.description ?? ''), createdBy: actor.userId })
      .returning();
    await this.db.insert(spaceMembers).values({ spaceId: space!.id, userId: actor.userId, perm: 'manager', invitedBy: actor.userId });
    await this.emit(space!.id, 'space.created', { spaceId: space!.id, name }, actor.userId);
    return { id: space!.id };
  }

  /** 我的空间（含我的档位；归档的带 archivedAt 由客户端过滤展示）。 */
  async listMySpaces(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db
      .select({ space: spaces, perm: spaceMembers.perm })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, userId))
      .orderBy(asc(spaces.createdAt));
    return rows.map(({ space, perm }) => this.spaceDto(space, perm as SpacePerm));
  }

  private spaceDto(s: SpaceRow, myPerm: SpacePerm): Record<string, unknown> {
    return {
      id: s.id, teamId: s.teamId, name: s.name, description: s.description,
      archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
      createdBy: s.createdBy, createdAt: s.createdAt.toISOString(), myPerm,
    };
  }

  /** 成员才可见；非成员 404（不泄露存在性，SPEC §4）。 */
  private async requireSpace(spaceId: string, userId: string): Promise<{ space: SpaceRow; perm: SpacePerm }> {
    const [row] = await this.db
      .select({ space: spaces, perm: spaceMembers.perm })
      .from(spaces)
      .innerJoin(spaceMembers, and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, userId)))
      .where(eq(spaces.id, spaceId))
      .limit(1);
    if (!row) throw new SpaceError(404, 'ENOENT', '空间不存在');
    return { space: row.space, perm: row.perm as SpacePerm };
  }

  async updateSpace(spaceId: string, actor: SpaceActor, patch: { name?: string; archived?: boolean }): Promise<Record<string, unknown>> {
    const { perm } = await this.requireSpace(spaceId, actor.userId);
    if (!canSpace('manage', perm)) throw new SpaceError(403, 'EFORBIDDEN', `权限不足（${perm} 不能管理空间）`);
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = String(patch.name ?? '').trim();
      if (!name) throw new SpaceError(422, 'ENAME', '空间名称不能为空');
      set.name = name;
    }
    if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
    const [updated] = await this.db.update(spaces).set(set).where(eq(spaces.id, spaceId)).returning();
    await this.emit(spaceId, 'space.updated', { spaceId, name: updated!.name, archived: Boolean(updated!.archivedAt) }, actor.userId);
    return this.spaceDto(updated!, perm);
  }

  // ============================ 成员 ============================

  private async assertManager(spaceId: string, userId: string): Promise<SpaceRow> {
    const { space, perm } = await this.requireSpace(spaceId, userId);
    if (!canSpace('manage', perm)) throw new SpaceError(403, 'EFORBIDDEN', `权限不足（${perm} 不能管理成员）`);
    return space;
  }

  async addMember(spaceId: string, actor: SpaceActor, input: { userId: string; perm: string }): Promise<Record<string, unknown>> {
    const space = await this.assertManager(spaceId, actor.userId);
    this.assertWritable(space);
    const perm = this.parseSpacePerm(input.perm);
    const [target] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, String(input.userId ?? ''))).limit(1);
    if (!target) throw new SpaceError(404, 'ENOENT', '目标用户不存在');
    await this.db
      .insert(spaceMembers)
      .values({ spaceId, userId: target.id, perm, invitedBy: actor.userId })
      .onConflictDoUpdate({ target: [spaceMembers.spaceId, spaceMembers.userId], set: { perm, invitedBy: actor.userId } });
    await this.audit(actor.userId, 'member.grant', target.id, { spaceId, perm });
    await this.emit(spaceId, 'member.added', { userId: target.id, perm }, actor.userId);
    return { userId: target.id, perm };
  }

  async listMembers(spaceId: string, actor: SpaceActor): Promise<Array<Record<string, unknown>>> {
    await this.requireSpace(spaceId, actor.userId); // 任意成员可读
    const rows = await this.db
      .select({ m: spaceMembers, username: users.username, displayName: users.displayName })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, spaceId))
      .orderBy(asc(spaceMembers.createdAt));
    return rows.map(({ m, username, displayName }) => ({
      userId: m.userId, username, displayName, perm: m.perm,
      invitedBy: m.invitedBy, createdAt: m.createdAt.toISOString(),
    }));
  }

  async updateMember(spaceId: string, actor: SpaceActor, targetUserId: string, input: { perm: string }): Promise<{ ok: true }> {
    const space = await this.assertManager(spaceId, actor.userId);
    this.assertWritable(space);
    const perm = this.parseSpacePerm(input.perm);
    const [target] = await this.db
      .select().from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw new SpaceError(404, 'ENOENT', '成员不存在');
    if (target.perm === 'manager' && perm !== 'manager') await this.assertNotLastManager(spaceId, targetUserId);
    await this.db
      .update(spaceMembers).set({ perm })
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)));
    await this.audit(actor.userId, 'member.grant', targetUserId, { spaceId, perm, changed: true });
    await this.emit(spaceId, 'member.updated', { userId: targetUserId, perm }, actor.userId);
    return { ok: true };
  }

  async removeMember(spaceId: string, actor: SpaceActor, targetUserId: string): Promise<{ ok: true }> {
    const space = await this.assertManager(spaceId, actor.userId);
    this.assertWritable(space);
    const [target] = await this.db
      .select().from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)))
      .limit(1);
    if (!target) throw new SpaceError(404, 'ENOENT', '成员不存在');
    if (target.perm === 'manager') await this.assertNotLastManager(spaceId, targetUserId);
    await this.db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)));
    await this.audit(actor.userId, 'member.revoke', targetUserId, { spaceId, perm: target.perm });
    await this.emit(spaceId, 'member.removed', { userId: targetUserId }, actor.userId);
    return { ok: true };
  }

  private async assertNotLastManager(spaceId: string, targetUserId: string): Promise<void> {
    const managers = await this.db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.perm, 'manager')));
    if (managers.length <= 1 && managers[0]?.userId === targetUserId) {
      throw new SpaceError(409, 'ELASTMANAGER', '不能移除/降级最后一位管理者');
    }
  }

  private parseSpacePerm(v: unknown): SpacePerm {
    if (!isSpacePerm(v)) throw new SpaceError(422, 'EPERM', 'perm 必须为 viewer | contributor | manager');
    return v;
  }

  // ============================ 权限解析（树与直读同一路径） ============================

  /**
   * 可见集 + 有效档位：节点自身未软删、未被 none 覆盖，且祖先链同样成立
   * （父被删/被隐藏 → 子树一并隐藏，避免悬挂与越权直读）。覆盖优先级：
   * 用户覆盖 > 团队覆盖 > 空间档位。
   */
  private async visibility(
    space: SpaceRow, spacePerm: SpacePerm, actor: SpaceActor, includeDeleted = false,
  ): Promise<{ visible: Map<string, NodeRow>; permOf: (nodeId: string) => NodePerm }> {
    const nodes = await this.db.select().from(spaceNodes).where(eq(spaceNodes.spaceId, space.id));
    const ovs = nodes.length
      ? await this.db.select().from(spaceNodeOverrides).where(inArray(spaceNodeOverrides.nodeId, nodes.map((n) => n.id)))
      : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const permCache = new Map<string, NodePerm>();
    const permOf = (nodeId: string): NodePerm => {
      if (!permCache.has(nodeId)) {
        const n = byId.get(nodeId);
        const userOv = n && ovs.find((o) => o.nodeId === n.id && o.subjectId === actor.userId);
        const teamOv = n && actor.teamId ? ovs.find((o) => o.nodeId === n.id && o.subjectId === actor.teamId) : undefined;
        permCache.set(nodeId, effectivePerm(spacePerm, (userOv ?? teamOv)?.perm as NodePerm | undefined) as NodePerm);
      }
      return permCache.get(nodeId)!;
    };
    const visible = new Map<string, NodeRow>();
    const okCache = new Map<string, boolean>();
    const isListed = (n: NodeRow, path: Set<string>): boolean => {
      if (okCache.has(n.id)) return okCache.get(n.id)!;
      if (path.has(n.id)) return false; // 脏数据环防护
      path.add(n.id);
      let ok = (includeDeleted || !n.deletedAt) && permOf(n.id) !== 'none';
      if (ok && n.parentId) {
        const p = byId.get(n.parentId);
        ok = p ? isListed(p, path) : false; // 悬挂父 → 隐藏
      }
      path.delete(n.id);
      okCache.set(n.id, ok);
      return ok;
    };
    for (const n of nodes) if (isListed(n, new Set())) visible.set(n.id, n);
    return { visible, permOf };
  }

  /** 节点动作入口：404 伪装（非成员/none/不可见）→ 403（档位不足，SPEC §4）。 */
  private async requireNode(
    spaceId: string, actor: SpaceActor, nodeId: string, action: SpaceAction, opts: { includeDeleted?: boolean } = {},
  ): Promise<{ space: SpaceRow; node: NodeRow; perm: NodePerm }> {
    const { space, perm: spacePerm } = await this.requireSpace(spaceId, actor.userId);
    const { visible, permOf } = await this.visibility(space, spacePerm, actor, opts.includeDeleted);
    const node = visible.get(nodeId);
    if (!node) throw new SpaceError(404, 'ENOENT', '节点不存在');
    const perm = permOf(nodeId);
    if (!canSpace(action, perm, { isOwner: node.createdBy === actor.userId })) {
      throw new SpaceError(403, 'EFORBIDDEN', `权限不足（${perm} 不能 ${action}）`);
    }
    return { space, node, perm };
  }

  private assertWritable(space: SpaceRow): void {
    if (space.archivedAt) throw new SpaceError(409, 'EARCHIVED', '空间已归档（只读）');
  }

  // ============================ 节点树 ============================

  async createNode(
    spaceId: string, actor: SpaceActor, input: { parentId?: string | null; type: string; name: string; sortKey?: number },
  ): Promise<Record<string, unknown>> {
    const { space, perm: spacePerm } = await this.requireSpace(spaceId, actor.userId);
    this.assertWritable(space);
    if (!NODE_TYPES.includes(input.type as NodeType)) throw new SpaceError(422, 'ETYPE', 'type 必须为 folder | md | csv | html | file');
    const name = String(input.name ?? '').trim();
    if (!name) throw new SpaceError(422, 'ENAME', '节点名称不能为空');
    if (!canSpace('edit', spacePerm)) throw new SpaceError(403, 'EFORBIDDEN', `权限不足（${spacePerm} 不能新建节点）`);
    let parentId: string | null = null;
    if (input.parentId) {
      const { visible, permOf } = await this.visibility(space, spacePerm, actor);
      const parent = visible.get(input.parentId);
      if (!parent) throw new SpaceError(404, 'ENOENT', '父节点不存在');
      if (parent.type !== 'folder') throw new SpaceError(422, 'EPARENT', '父节点必须是文件夹');
      // 在被覆盖降档的文件夹里新建：按父的有效档位判定
      if (!canSpace('edit', permOf(parent.id))) throw new SpaceError(403, 'EFORBIDDEN', '权限不足（该文件夹对你降档）');
      parentId = parent.id;
    }
    const [node] = await this.db
      .insert(spaceNodes)
      .values({
        spaceId, parentId, type: input.type as NodeType, name,
        sortKey: Number.isFinite(Number(input.sortKey)) ? Number(input.sortKey) : 0,
        createdBy: actor.userId, updatedBy: actor.userId,
      })
      .returning();
    if (DOC_TYPES.includes(input.type as NodeType)) {
      await this.db.insert(spaceDocs).values({ nodeId: node!.id, currentVersion: 0 });
    }
    await this.emit(spaceId, 'node.created', { nodeId: node!.id, type: node!.type, name, parentId }, actor.userId);
    return this.nodeDto(node!, spacePerm);
  }

  async tree(spaceId: string, actor: SpaceActor): Promise<Array<Record<string, unknown>>> {
    const { space, perm: spacePerm } = await this.requireSpace(spaceId, actor.userId);
    const nodes = await this.db.select().from(spaceNodes).where(eq(spaceNodes.spaceId, space.id));
    const { visible, permOf } = await this.visibility(space, spacePerm, actor);
    // 父先于子输出，客户端可直接建树
    const ordered: NodeRow[] = [];
    const seen = new Set<string>();
    const push = (n: NodeRow, path: Set<string>): void => {
      if (seen.has(n.id) || path.has(n.id)) return;
      path.add(n.id);
      if (n.parentId) {
        const p = visible.get(n.parentId);
        if (p) push(p, path);
      }
      path.delete(n.id);
      seen.add(n.id);
      ordered.push(n);
    };
    for (const n of nodes) if (visible.has(n.id)) push(n, new Set());
    return ordered.map((n) => this.nodeDto(n, permOf(n.id)));
  }

  async updateNode(
    spaceId: string, actor: SpaceActor, nodeId: string, patch: { name?: string; parentId?: string | null; sortKey?: number },
  ): Promise<Record<string, unknown>> {
    const { space, perm } = await this.requireNode(spaceId, actor, nodeId, 'edit');
    this.assertWritable(space);
    const set: Record<string, unknown> = { updatedBy: actor.userId, updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = String(patch.name ?? '').trim();
      if (!name) throw new SpaceError(422, 'ENAME', '节点名称不能为空');
      set.name = name;
    }
    if (patch.sortKey !== undefined && Number.isFinite(Number(patch.sortKey))) set.sortKey = Number(patch.sortKey);
    if (patch.parentId !== undefined) {
      if (patch.parentId === null) {
        set.parentId = null;
      } else {
        const { visible } = await this.visibility(space, perm as SpacePerm, actor);
        const parent = visible.get(patch.parentId);
        if (!parent) throw new SpaceError(404, 'ENOENT', '目标父节点不存在');
        if (parent.type !== 'folder') throw new SpaceError(422, 'EPARENT', '目标父节点必须是文件夹');
        // 环路防护：从新父沿 parent 链向上走，遇到自己即环
        const parents = await this.db.select({ id: spaceNodes.id, parentId: spaceNodes.parentId }).from(spaceNodes).where(eq(spaceNodes.spaceId, spaceId));
        const byId = new Map(parents.map((n) => [n.id, n.parentId]));
        let cursor: string | null = parent.id;
        const guard = new Set<string>();
        while (cursor) {
          if (cursor === nodeId) throw new SpaceError(409, 'ECYCLE', '不能把节点移动到它自己的子树下');
          if (guard.has(cursor)) break;
          guard.add(cursor);
          cursor = byId.get(cursor) ?? null;
        }
        set.parentId = parent.id;
      }
    }
    const [updated] = await this.db.update(spaceNodes).set(set).where(eq(spaceNodes.id, nodeId)).returning();
    await this.emit(spaceId, 'node.updated', { nodeId, name: updated!.name, parentId: updated!.parentId }, actor.userId);
    return this.nodeDto(updated!, perm);
  }

  async deleteNode(spaceId: string, actor: SpaceActor, nodeId: string): Promise<{ ok: true }> {
    const { space, node } = await this.requireNode(spaceId, actor, nodeId, 'delete'); // contributor 仅本人节点（canSpace 内判）
    this.assertWritable(space);
    await this.db
      .update(spaceNodes)
      .set({ deletedAt: new Date(), deletedBy: actor.userId, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(spaceNodes.id, nodeId));
    await this.audit(actor.userId, 'node.delete', nodeId, { spaceId, name: node.name });
    await this.emit(spaceId, 'node.deleted', { nodeId, name: node.name }, actor.userId);
    return { ok: true };
  }

  async restoreNode(spaceId: string, actor: SpaceActor, nodeId: string): Promise<Record<string, unknown>> {
    const { space, perm: spacePerm } = await this.requireSpace(spaceId, actor.userId);
    this.assertWritable(space);
    const [node] = await this.db
      .select().from(spaceNodes)
      .where(and(eq(spaceNodes.id, nodeId), eq(spaceNodes.spaceId, spaceId)))
      .limit(1);
    if (!node) throw new SpaceError(404, 'ENOENT', '节点不存在');
    if (!node.deletedAt) throw new SpaceError(409, 'ENOTDELETED', '节点不在回收站中');
    // permOf 基于全量节点计算（含已删节点）：被 none 隐藏的节点恢复也伪装 404
    const { permOf } = await this.visibility(space, spacePerm, actor);
    const perm = permOf(nodeId);
    if (perm === 'none') throw new SpaceError(404, 'ENOENT', '节点不存在');
    if (!canSpace('edit', perm)) throw new SpaceError(403, 'EFORBIDDEN', `权限不足（${perm} 不能恢复节点）`);
    const [updated] = await this.db
      .update(spaceNodes)
      .set({ deletedAt: null, deletedBy: null, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(spaceNodes.id, nodeId))
      .returning();
    await this.emit(spaceId, 'node.restored', { nodeId }, actor.userId);
    return this.nodeDto(updated!, perm);
  }

  private nodeDto(n: NodeRow, perm: NodePerm): Record<string, unknown> {
    return {
      id: n.id, spaceId: n.spaceId, parentId: n.parentId, type: n.type, name: n.name,
      sortKey: n.sortKey, perm,
      createdBy: n.createdBy, updatedBy: n.updatedBy,
      updatedAt: n.updatedAt.toISOString(),
      createdAt: n.createdAt.toISOString(),
    };
  }

  // ============================ 文档（MD/CSV 版本链） ============================

  /** 空间内全文检索（FR-TC-21）：标题 + MD/CSV 最新版内容，ILIKE 起步
   * （NFR-TC2 规模约束内够用）；只返回调用者可见节点。 */
  async search(
    spaceId: string, actor: SpaceActor, rawQuery: string, limit = 50,
  ): Promise<Array<Record<string, unknown>>> {
    const { space, perm: spacePerm } = await this.requireSpace(spaceId, actor.userId);
    const query = rawQuery.trim();
    if (!query) return [];
    const nodes = await this.db.select().from(spaceNodes).where(eq(spaceNodes.spaceId, space.id));
    const { visible, permOf } = await this.visibility(space, spacePerm, actor);
    const needle = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const contentHits = await this.db
      .select({ nodeId: spaceDocVersions.nodeId })
      .from(spaceDocVersions)
      .innerJoin(spaceDocs, and(eq(spaceDocs.nodeId, spaceDocVersions.nodeId), eq(spaceDocs.currentVersion, spaceDocVersions.version)))
      .where(ilike(spaceDocVersions.content, needle));
    const contentHitIds = new Set(contentHits.map((row) => row.nodeId));
    const out: Array<Record<string, unknown>> = [];
    for (const node of nodes) {
      if (!visible.has(node.id) || node.deletedAt) continue;
      const inTitle = node.name.toLowerCase().includes(query.toLowerCase());
      const inContent = contentHitIds.has(node.id);
      if (!inTitle && !inContent) continue;
      out.push({ ...this.nodeDto(node, permOf(node.id)), matchedIn: inTitle ? 'title' : 'content' });
      if (out.length >= Math.max(1, Math.min(limit, 100))) break;
    }
    // 标题命中排前，其余按树序
    out.sort((a, b) => Number(b.matchedIn === 'title') - Number(a.matchedIn === 'title'));
    return out;
  }

  async getDoc(spaceId: string, actor: SpaceActor, nodeId: string, version?: number): Promise<Record<string, unknown>> {
    const { node } = await this.requireNode(spaceId, actor, nodeId, 'view');
    if (!DOC_TYPES.includes(node.type as NodeType)) throw new SpaceError(422, 'ENOTDOC', '该节点类型没有文本文档');
    if (version !== undefined) {
      const [v] = await this.db
        .select().from(spaceDocVersions)
        .where(and(eq(spaceDocVersions.nodeId, nodeId), eq(spaceDocVersions.version, version)))
        .limit(1);
      if (!v) throw new SpaceError(404, 'ENOENT', '版本不存在（可能已滚动清理）');
      return this.docVersionDto(nodeId, v.version, v);
    }
    const [doc] = await this.db.select().from(spaceDocs).where(eq(spaceDocs.nodeId, nodeId)).limit(1);
    const currentVersion = doc?.currentVersion ?? 0;
    if (currentVersion === 0) {
      return { nodeId, version: 0, content: '', sha256: null, authorId: null, source: null, createdAt: null, currentVersion: 0 };
    }
    const [v] = await this.db
      .select().from(spaceDocVersions)
      .where(and(eq(spaceDocVersions.nodeId, nodeId), eq(spaceDocVersions.version, currentVersion)))
      .limit(1);
    if (!v) throw new SpaceError(500, 'ECHAIN', '版本链损坏');
    return this.docVersionDto(nodeId, currentVersion, v);
  }

  private docVersionDto(nodeId: string, currentVersion: number, v: typeof spaceDocVersions.$inferSelect): Record<string, unknown> {
    return {
      nodeId, version: v.version, content: v.content, sha256: v.sha256,
      authorId: v.authorId, source: v.source, createdAt: v.createdAt.toISOString(),
      currentVersion,
    };
  }

  /**
   * 乐观锁保存：baseVersion 必须等于当前版本，否则 409 EVERSION。
   * 成功 = 新版本行 + current 前移 + 20 版滚动清理 + doc.version 事件（单事务）。
   */
  async saveDoc(
    spaceId: string, actor: SpaceActor, nodeId: string, input: { content: string; baseVersion: number; source?: string },
  ): Promise<Record<string, unknown>> {
    const { space, node } = await this.requireNode(spaceId, actor, nodeId, 'edit');
    this.assertWritable(space);
    if (!DOC_TYPES.includes(node.type as NodeType)) throw new SpaceError(422, 'ENOTDOC', '该节点类型没有文本文档');
    const content = String(input.content ?? '');
    if (!Number.isInteger(Number(input.baseVersion)) || Number(input.baseVersion) < 0) {
      throw new SpaceError(422, 'EBASEVERSION', 'baseVersion 必须为非负整数');
    }
    let source = 'human';
    if (input.source !== undefined && input.source !== null && input.source !== '') {
      if (input.source !== 'human' && input.source !== 'agent-direct') {
        throw new SpaceError(422, 'ESOURCE', 'source 必须为 human | agent-direct（ai-accept 仅由服务端事务写入）');
      }
      source = input.source;
    }
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const baseVersion = Number(input.baseVersion);
    return this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(spaceDocs).where(eq(spaceDocs.nodeId, nodeId)).for('update').limit(1);
      const currentVersion = doc?.currentVersion ?? 0;
      if (baseVersion !== currentVersion) {
        throw new SpaceError(409, 'EVERSION', `版本冲突：服务端当前为 v${currentVersion}，提交基于 v${baseVersion}`);
      }
      const newVersion = currentVersion + 1;
      await tx.insert(spaceDocVersions).values({ nodeId, version: newVersion, content, sha256, authorId: actor.userId, source });
      await tx
        .insert(spaceDocs)
        .values({ nodeId, currentVersion: newVersion, updatedAt: new Date() })
        .onConflictDoUpdate({ target: spaceDocs.nodeId, set: { currentVersion: newVersion, updatedAt: new Date() } });
      await tx
        .update(spaceNodes)
        .set({ updatedBy: actor.userId, updatedAt: new Date() })
        .where(eq(spaceNodes.id, nodeId));
      // 20 版滚动：只保留最近 SPACE_VERSIONS_KEEP 个版本
      if (newVersion > SPACE_VERSIONS_KEEP) {
        await tx
          .delete(spaceDocVersions)
          .where(and(eq(spaceDocVersions.nodeId, nodeId), sql`${spaceDocVersions.version} <= ${newVersion - SPACE_VERSIONS_KEEP}`));
      }
      const seq = await this.recordEvent(tx, spaceId, 'doc.version', { nodeId, version: newVersion }, actor.userId);
      return { nodeId, version: newVersion, sha256, source, seq };
    });
  }

  // ============================ 评论 ============================

  async listComments(spaceId: string, actor: SpaceActor, nodeId: string): Promise<Array<Record<string, unknown>>> {
    await this.requireNode(spaceId, actor, nodeId, 'view');
    const rows = await this.db
      .select().from(comments)
      .where(eq(comments.nodeId, nodeId))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    return rows.map((c) => this.commentDto(c));
  }

  async createComment(
    spaceId: string, actor: SpaceActor, nodeId: string, input: { body: string; anchor?: unknown },
  ): Promise<Record<string, unknown>> {
    const { space } = await this.requireNode(spaceId, actor, nodeId, 'comment');
    this.assertWritable(space);
    const body = String(input.body ?? '').trim();
    if (!body) throw new SpaceError(422, 'EBODY', '评论内容不能为空');
    const [c] = await this.db
      .insert(comments)
      .values({ nodeId, authorId: actor.userId, body, anchor: (input.anchor ?? null) as object | null })
      .returning();
    await this.emit(spaceId, 'comment.created', { nodeId, commentId: c!.id }, actor.userId);
    return this.commentDto(c!);
  }

  async replyComment(
    spaceId: string, actor: SpaceActor, nodeId: string, commentId: string, input: { body: string },
  ): Promise<Record<string, unknown>> {
    const { space } = await this.requireNode(spaceId, actor, nodeId, 'comment');
    this.assertWritable(space);
    const body = String(input.body ?? '').trim();
    if (!body) throw new SpaceError(422, 'EBODY', '回复内容不能为空');
    const [root] = await this.db
      .select().from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.nodeId, nodeId)))
      .limit(1);
    if (!root) throw new SpaceError(404, 'ENOENT', '评论不存在');
    const [c] = await this.db
      .insert(comments)
      .values({ nodeId, authorId: actor.userId, body, parentId: root.parentId ?? root.id })
      .returning();
    await this.emit(spaceId, 'comment.replied', { nodeId, commentId: c!.id, parentId: c!.parentId }, actor.userId);
    return this.commentDto(c!);
  }

  /** 解开/重开线程：线程发起人或 manager；作用于根评论及其全部回复。 */
  async resolveComment(
    spaceId: string, actor: SpaceActor, nodeId: string, commentId: string, input: { status?: string },
  ): Promise<Record<string, unknown>> {
    const { space, perm } = await this.requireNode(spaceId, actor, nodeId, 'comment');
    this.assertWritable(space);
    const status = input.status === 'open' ? 'open' : input.status === 'resolved' ? 'resolved' : null;
    if (!status) throw new SpaceError(422, 'ESTATUS', 'status 必须为 open | resolved');
    const [root] = await this.db
      .select().from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.nodeId, nodeId)))
      .limit(1);
    if (!root) throw new SpaceError(404, 'ENOENT', '评论不存在');
    if (root.authorId !== actor.userId && !canSpace('manage', perm)) {
      throw new SpaceError(403, 'EFORBIDDEN', '仅评论作者或管理者可流转状态');
    }
    const threadRootId = root.parentId ?? root.id;
    const now = new Date();
    await this.db.update(comments).set({ status, updatedAt: now }).where(eq(comments.id, threadRootId));
    await this.db.update(comments).set({ status, updatedAt: now }).where(eq(comments.parentId, threadRootId));
    await this.emit(spaceId, 'comment.status', { nodeId, commentId: threadRootId, status }, actor.userId);
    const [updated] = await this.db.select().from(comments).where(eq(comments.id, threadRootId)).limit(1);
    return this.commentDto(updated!);
  }

  private commentDto(c: typeof comments.$inferSelect): Record<string, unknown> {
    return {
      id: c.id, nodeId: c.nodeId, anchor: c.anchor, authorId: c.authorId, body: c.body,
      parentId: c.parentId, status: c.status,
      createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    };
  }

  // ============================ 修订建议 ============================

  async listRevisions(spaceId: string, actor: SpaceActor, nodeId: string): Promise<Array<Record<string, unknown>>> {
    await this.requireNode(spaceId, actor, nodeId, 'view');
    const rows = await this.db
      .select().from(revisionSuggestions)
      .where(eq(revisionSuggestions.nodeId, nodeId))
      .orderBy(asc(revisionSuggestions.createdAt), asc(revisionSuggestions.id));
    return rows.map((r) => this.revisionDto(r));
  }

  /** 提出建议=「提议」级动作（不改正文，接受才写版本链）：comment 档即可（viewer+）。 */
  async createRevision(
    spaceId: string, actor: SpaceActor, nodeId: string,
    input: { anchor?: unknown; originalText: string; revisedText: string; rationale?: string; producedBy?: string; model?: string },
  ): Promise<Record<string, unknown>> {
    const { space } = await this.requireNode(spaceId, actor, nodeId, 'comment');
    this.assertWritable(space);
    const originalText = String(input.originalText ?? '');
    const revisedText = String(input.revisedText ?? '');
    if (!originalText) throw new SpaceError(422, 'EORIGINAL', 'originalText 不能为空');
    if (!revisedText) throw new SpaceError(422, 'EREVISED', 'revisedText 不能为空');
    const producedBy = input.producedBy === 'agent' ? 'agent' : 'user';
    const [r] = await this.db
      .insert(revisionSuggestions)
      .values({
        nodeId, anchor: (input.anchor ?? null) as object | null,
        originalText, revisedText, rationale: String(input.rationale ?? ''),
        requestedBy: actor.userId, producedBy, model: input.model ?? null,
      })
      .returning();
    await this.emit(spaceId, 'revision.created', { nodeId, suggestionId: r!.id, producedBy }, actor.userId);
    // FR-TC-10: an AI-produced suggestion batch pings the node's open comment
    // authors (never the requester) so they review what touched their comments.
    if (producedBy === 'agent') {
      const openComments = await this.db
        .selectDistinct({ authorId: comments.authorId })
        .from(comments)
        .where(and(eq(comments.nodeId, nodeId), eq(comments.status, 'open')));
      const recipients = new Set(
        openComments.map((row) => row.authorId).filter((id): id is string => Boolean(id) && id !== actor.userId),
      );
      for (const userId of recipients) {
        await this.db.insert(spaceNotifications).values({
          userId, spaceId, nodeId,
          kind: 'revision.review-requested',
          payload: { suggestionId: r!.id, count: recipients.size },
        });
      }
    }
    return this.revisionDto(r!);
  }

  /** 我的未读空间通知（轮询消费；frontier = createdAt ISO 游标）。 */
  async listNotifications(userId: string, sinceIso?: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db
      .select()
      .from(spaceNotifications)
      .where(and(eq(spaceNotifications.userId, userId), gt(spaceNotifications.createdAt, sinceIso ? new Date(sinceIso) : new Date(0))))
      .orderBy(asc(spaceNotifications.createdAt))
      .limit(100);
    return rows.map((row) => ({
      id: row.id, spaceId: row.spaceId, nodeId: row.nodeId,
      kind: row.kind, payload: row.payload, readAt: row.readAt,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async markNotificationsRead(userId: string, ids: string[]): Promise<{ ok: true }> {
    if (!ids.length) return { ok: true };
    await this.db
      .update(spaceNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(spaceNotifications.userId, userId), inArray(spaceNotifications.id, ids)));
    return { ok: true };
  }

  /**
   * 接受 = 服务端事务重读当前正文 → 原文精确匹配替换 → 新版本（source='ai-accept'）；
   * 原文已变化/不存在 → 409 EANCHOR（SPEC §3.3 串行合并）。
   * contributor 仅能处理自己请求的建议；manager 任意（SPEC §3.1）。
   */
  async decideRevision(
    spaceId: string, actor: SpaceActor, nodeId: string, suggestionId: string, input: { decision: string },
  ): Promise<Record<string, unknown>> {
    const { space, perm } = await this.requireNode(spaceId, actor, nodeId, 'view');
    this.assertWritable(space);
    const decision = input.decision;
    if (decision !== 'accepted' && decision !== 'rejected') throw new SpaceError(422, 'EDECISION', 'decision 必须为 accepted | rejected');
    const [sug] = await this.db
      .select().from(revisionSuggestions)
      .where(and(eq(revisionSuggestions.id, suggestionId), eq(revisionSuggestions.nodeId, nodeId)))
      .limit(1);
    if (!sug) throw new SpaceError(404, 'ENOENT', '修订建议不存在');
    if (sug.status !== 'pending') throw new SpaceError(409, 'ESTATE', '该建议已处理');
    if (!canSpace('decideRevision', perm, { isOwner: sug.requestedBy === actor.userId })) {
      throw new SpaceError(403, 'EFORBIDDEN', `权限不足（${perm} 仅能处理自己请求的建议）`);
    }

    if (decision === 'rejected') {
      const [updated] = await this.db
        .update(revisionSuggestions)
        .set({ status: 'rejected', decidedAt: new Date() })
        .where(eq(revisionSuggestions.id, suggestionId))
        .returning();
      await this.audit(actor.userId, 'revision.decide', suggestionId, { nodeId, decision });
      await this.emit(spaceId, 'revision.decided', { nodeId, suggestionId, status: 'rejected' }, actor.userId);
      return this.revisionDto(updated!);
    }

    const result = await this.db.transaction(async (tx) => {
      const [doc] = await tx.select().from(spaceDocs).where(eq(spaceDocs.nodeId, nodeId)).for('update').limit(1);
      const currentVersion = doc?.currentVersion ?? 0;
      const content = currentVersion > 0
        ? (await tx
            .select().from(spaceDocVersions)
            .where(and(eq(spaceDocVersions.nodeId, nodeId), eq(spaceDocVersions.version, currentVersion)))
            .limit(1))[0]?.content ?? ''
        : '';
      const idx = content.indexOf(sug.originalText);
      if (!sug.originalText || idx === -1) {
        throw new SpaceError(409, 'EANCHOR', '锚定原文已变化或不存在，无法应用该建议');
      }
      const newContent = content.slice(0, idx) + sug.revisedText + content.slice(idx + sug.originalText.length);
      const newVersion = currentVersion + 1;
      const sha256 = createHash('sha256').update(newContent, 'utf8').digest('hex');
      await tx.insert(spaceDocVersions).values({ nodeId, version: newVersion, content: newContent, sha256, authorId: actor.userId, source: 'ai-accept' });
      await tx
        .insert(spaceDocs)
        .values({ nodeId, currentVersion: newVersion, updatedAt: new Date() })
        .onConflictDoUpdate({ target: spaceDocs.nodeId, set: { currentVersion: newVersion, updatedAt: new Date() } });
      await tx.update(spaceNodes).set({ updatedBy: actor.userId, updatedAt: new Date() }).where(eq(spaceNodes.id, nodeId));
      if (newVersion > SPACE_VERSIONS_KEEP) {
        await tx
          .delete(spaceDocVersions)
          .where(and(eq(spaceDocVersions.nodeId, nodeId), sql`${spaceDocVersions.version} <= ${newVersion - SPACE_VERSIONS_KEEP}`));
      }
      const [updated] = await tx
        .update(revisionSuggestions)
        .set({ status: 'accepted', acceptedBy: actor.userId, decidedAt: new Date() })
        .where(eq(revisionSuggestions.id, suggestionId))
        .returning();
      await this.recordEvent(tx, spaceId, 'doc.version', { nodeId, version: newVersion }, actor.userId);
      await this.recordEvent(tx, spaceId, 'revision.decided', { nodeId, suggestionId, status: 'accepted' }, actor.userId);
      return { dto: this.revisionDto(updated!), version: newVersion };
    });
    await this.audit(actor.userId, 'revision.decide', suggestionId, { nodeId, decision, version: result.version });
    return { ...result.dto, appliedVersion: result.version };
  }

  private revisionDto(r: typeof revisionSuggestions.$inferSelect): Record<string, unknown> {
    return {
      id: r.id, nodeId: r.nodeId, anchor: r.anchor,
      originalText: r.originalText, revisedText: r.revisedText, rationale: r.rationale,
      status: r.status, requestedBy: r.requestedBy, producedBy: r.producedBy, model: r.model,
      acceptedBy: r.acceptedBy,
      createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    };
  }

  // ============================ 事件流（WS hub 复用的增量游标） ============================

  async listEvents(spaceId: string, actor: SpaceActor, since: number): Promise<Record<string, unknown>> {
    await this.requireSpace(spaceId, actor.userId); // 任意成员可拉取
    const rows = await this.db
      .select().from(spaceEvents)
      .where(and(eq(spaceEvents.spaceId, spaceId), gt(spaceEvents.seq, since)))
      .orderBy(asc(spaceEvents.seq))
      .limit(200);
    const [maxRow] = await this.db
      .select({ maxSeq: sql<string | null>`MAX(${spaceEvents.seq})` })
      .from(spaceEvents)
      .where(eq(spaceEvents.spaceId, spaceId));
    return {
      events: rows.map((e) => ({
        seq: Number(e.seq), type: e.type, payload: e.payload, actorId: e.actorId,
        createdAt: e.createdAt.toISOString(),
      })),
      lastSeq: Number(maxRow?.maxSeq ?? 0),
    };
  }

  // ============================ 邀请链接 ============================

  async createInvite(
    spaceId: string, actor: SpaceActor,
    input: { perm?: string; access?: string; expiresInDays?: number; maxUses?: number | null },
  ): Promise<Record<string, unknown>> {
    const space = await this.assertManager(spaceId, actor.userId);
    this.assertWritable(space);
    const perm = this.parseSpacePerm(input.perm ?? 'viewer');
    const access = input.access === 'view' ? 'view' : 'apply';
    const days = Number(input.expiresInDays ?? 7);
    if (!Number.isFinite(days) || days <= 0 || days > 365) throw new SpaceError(422, 'EEXPIRES', 'expiresInDays 必须为 1-365');
    let maxUses: number | null = null;
    if (input.maxUses !== undefined && input.maxUses !== null) {
      maxUses = Number(input.maxUses);
      if (!Number.isInteger(maxUses) || maxUses <= 0) throw new SpaceError(422, 'EMAXUSES', 'maxUses 必须为正整数');
    }
    // token 明文只在创建瞬间返回一次；库中仅存 sha256（SPEC §4，virtual_keys 同语义）
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    const [row] = await this.db
      .insert(inviteLinks)
      .values({ spaceId, tokenHash, perm, access, expiresAt, maxUses, createdBy: actor.userId })
      .returning();
    await this.audit(actor.userId, 'invite.create', row!.id, { spaceId, perm, access, expiresInDays: days, maxUses });
    await this.emit(spaceId, 'invite.created', { inviteId: row!.id, perm, access }, actor.userId);
    return {
      id: row!.id, token, perm, access,
      expiresAt: row!.expiresAt ? row!.expiresAt.toISOString() : null,
      maxUses: row!.maxUses,
    };
  }

  /**
   * 兑换邀请：认证用户以邀请档位加入空间。
   * 组织协作范围管控（SPEC：org_settings.collab_scope=internal 时仅组织内账号
   * 可加入）：当前 schema 无组织设置表/列 → 门禁暂不生效（迁移补列后在此校验
   * actor 所属账号 org_id）。
   */
  async redeemInvite(actor: SpaceActor, input: { token: string }): Promise<Record<string, unknown>> {
    const token = String(input.token ?? '').trim();
    if (!token) throw new SpaceError(422, 'ETOKEN', 'token 不能为空');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const [invite] = await this.db.select().from(inviteLinks).where(eq(inviteLinks.tokenHash, tokenHash)).limit(1);
    if (!invite) throw new SpaceError(404, 'ENOENT', '邀请链接无效');
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new SpaceError(410, 'EEXPIRED', '邀请链接已过期');
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw new SpaceError(410, 'EEXHAUSTED', '邀请链接使用次数已达上限');
    }
    const [space] = await this.db.select().from(spaces).where(eq(spaces.id, invite.spaceId)).limit(1);
    if (!space) throw new SpaceError(404, 'ENOENT', '空间不存在');
    this.assertWritable(space);
    await this.db
      .insert(spaceMembers)
      .values({ spaceId: invite.spaceId, userId: actor.userId, perm: invite.perm as SpacePerm, invitedBy: invite.createdBy })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: { perm: invite.perm as SpacePerm, invitedBy: invite.createdBy },
      });
    await this.db
      .update(inviteLinks)
      .set({ uses: invite.uses + 1 })
      .where(eq(inviteLinks.id, invite.id));
    await this.audit(actor.userId, 'invite.redeem', invite.id, { spaceId: invite.spaceId, perm: invite.perm });
    await this.emit(invite.spaceId, 'member.added', { userId: actor.userId, perm: invite.perm, via: 'invite' }, actor.userId);
    return { spaceId: invite.spaceId, perm: invite.perm };
  }

  // ============================ 节点覆盖（T52.2：node 级 none 显式 deny） ============================

  async setNodeOverride(
    spaceId: string, actor: SpaceActor, nodeId: string, subjectId: string, input: { perm: string },
  ): Promise<Record<string, unknown>> {
    const { space, perm: spacePerm } = await this.requireNode(spaceId, actor, nodeId, 'view');
    if (!canSpace('manage', spacePerm)) throw new SpaceError(403, 'EFORBIDDEN', '仅管理者可设置节点覆盖');
    this.assertWritable(space);
    if (!isNodePerm(input.perm)) throw new SpaceError(422, 'EPERM', 'perm 必须为 viewer | contributor | manager | none');
    await this.db
      .insert(spaceNodeOverrides)
      .values({ nodeId, subjectId, perm: input.perm })
      .onConflictDoUpdate({ target: [spaceNodeOverrides.nodeId, spaceNodeOverrides.subjectId], set: { perm: input.perm } });
    await this.audit(actor.userId, 'node.override', nodeId, { spaceId, subjectId, perm: input.perm });
    await this.emit(spaceId, 'node.updated', { nodeId, override: { subjectId, perm: input.perm } }, actor.userId);
    return { nodeId, subjectId, perm: input.perm };
  }

  async clearNodeOverride(spaceId: string, actor: SpaceActor, nodeId: string, subjectId: string): Promise<{ ok: true }> {
    const { space, perm: spacePerm } = await this.requireNode(spaceId, actor, nodeId, 'view');
    if (!canSpace('manage', spacePerm)) throw new SpaceError(403, 'EFORBIDDEN', '仅管理者可清除节点覆盖');
    this.assertWritable(space);
    await this.db
      .delete(spaceNodeOverrides)
      .where(and(eq(spaceNodeOverrides.nodeId, nodeId), eq(spaceNodeOverrides.subjectId, subjectId)));
    await this.emit(spaceId, 'node.updated', { nodeId, override: { subjectId, perm: null } }, actor.userId);
    return { ok: true };
  }

  /** yjs hub 的连接鉴权（T52.13）：view 档即可打开 html 文档；none 伪装 404。 */
  async assertHtmlDocAccess(spaceId: string, userId: string, nodeId: string): Promise<void> {
    await this.requireNode(spaceId, { userId, teamId: null }, nodeId, 'view');
  }

  // ============================ 文件上传（T52.5：file 走卷存储） ============================

  /** 上传为新 file 节点，或对既有 file 节点追加版本。20 版滚动窗口与交付物一致。 */
  async uploadFile(
    spaceId: string, actor: SpaceActor,
    input: { nodeId?: string; parentId?: string | null; name?: string; contentBase64: string },
  ): Promise<Record<string, unknown>> {
    if (!this.storageDir) throw new SpaceError(503, 'ENOSTORAGE', '服务端未配置文件卷存储');
    const content = Buffer.from(String(input.contentBase64 ?? ''), 'base64');
    if (!content.length) throw new SpaceError(422, 'EEMPTY', '上传内容为空');
    if (content.length > MAX_SPACE_FILE_SIZE) {
      throw new SpaceError(413, 'ETOOLARGE', `文件超过上限（${Math.round(MAX_SPACE_FILE_SIZE / 1024 / 1024)}MB）`);
    }
    let nodeId: string;
    let nodeName: string;
    if (input.nodeId) {
      const { space, node } = await this.requireNode(spaceId, actor, input.nodeId, 'edit');
      this.assertWritable(space);
      if (node.type !== 'file') throw new SpaceError(422, 'ETYPE', '只能对 file 节点追加版本');
      nodeId = node.id;
      nodeName = node.name;
    } else {
      const name = String(input.name ?? '').trim();
      if (!name) throw new SpaceError(422, 'ENAME', '新文件需要 name');
      const created = await this.createNode(spaceId, actor, {
        parentId: input.parentId ?? null, type: 'file', name,
      });
      nodeId = String(created.id);
      nodeName = name;
    }
    const sha = createHash('sha256').update(content).digest('hex');
    const [row] = await this.db
      .select({ current: sql<number>`COALESCE(MAX(${spaceFileVersions.version}), 0)` })
      .from(spaceFileVersions)
      .where(eq(spaceFileVersions.nodeId, nodeId));
    const versionNo = Number(row?.current ?? 0) + 1;
    const key = path.join(this.storageDir, 'spaces', nodeId, `v${versionNo}`);
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, content);
    await this.db.insert(spaceFileVersions).values({
      nodeId, version: versionNo, size: content.length, sha256: sha, storageKey: key, uploadedBy: actor.userId,
    });
    await this.db
      .update(spaceNodes)
      .set({ updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(spaceNodes.id, nodeId));
    // 20 版滚动：淘汰最旧（与 deliverables / spaceDocVersions 同一窗口语义）
    const stale = await this.db
      .select()
      .from(spaceFileVersions)
      .where(and(eq(spaceFileVersions.nodeId, nodeId), lt(spaceFileVersions.version, versionNo - SPACE_VERSIONS_KEEP + 1)));
    for (const oldRow of stale) {
      fs.rmSync(oldRow.storageKey, { force: true });
      await this.db.delete(spaceFileVersions)
        .where(and(eq(spaceFileVersions.nodeId, oldRow.nodeId), eq(spaceFileVersions.version, oldRow.version)));
    }
    await this.audit(actor.userId, 'file.upload', nodeId, { spaceId, name: nodeName, version: versionNo, size: content.length });
    await this.emit(spaceId, 'node.updated', { nodeId, name: nodeName, fileVersion: versionNo }, actor.userId);
    return { nodeId, name: nodeName, versionNo, size: content.length, sha256: sha };
  }

  async listFileVersions(
    spaceId: string, actor: SpaceActor, nodeId: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this.requireNode(spaceId, actor, nodeId, 'view');
    const rows = await this.db
      .select({ version: spaceFileVersions.version, size: spaceFileVersions.size, sha256: spaceFileVersions.sha256, createdAt: spaceFileVersions.createdAt })
      .from(spaceFileVersions)
      .where(eq(spaceFileVersions.nodeId, nodeId))
      .orderBy(desc(spaceFileVersions.version));
    return rows;
  }

  async downloadFile(
    spaceId: string, actor: SpaceActor, nodeId: string, version?: number,
  ): Promise<{ name: string; contentBase64: string; sha256: string; versionNo: number } | null> {
    if (!this.storageDir) throw new SpaceError(503, 'ENOSTORAGE', '服务端未配置文件卷存储');
    const { node } = await this.requireNode(spaceId, actor, nodeId, 'view');
    const rows = version
      ? await this.db.select().from(spaceFileVersions)
          .where(and(eq(spaceFileVersions.nodeId, nodeId), eq(spaceFileVersions.version, version))).limit(1)
      : await this.db.select().from(spaceFileVersions)
          .where(eq(spaceFileVersions.nodeId, nodeId)).orderBy(desc(spaceFileVersions.version)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      name: node.name,
      contentBase64: fs.readFileSync(row.storageKey).toString('base64'),
      sha256: row.sha256,
      versionNo: row.version,
    };
  }
}
