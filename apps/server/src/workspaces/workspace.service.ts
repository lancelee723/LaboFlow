import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  workspaces, workspaceMembers, sharedSessions, sharedSessionEntries,
} from '../db/schema.js';
import {
  acquireLock, canWorkspace, heartbeat, releaseLock,
  type WorkspacePerm, type WorkspaceAction, type LockAcquireResult,
} from './workspace-rules.js';

/**
 * T2.6 IO half: workspace CRUD, membership, shared-session lock operations,
 * idempotent entry ingestion (session_id+seq PK), delta pull (since seq),
 * and a push hub that WS connections subscribe to (T2.6 推流).
 */

export interface EntryLike {
  seq: number;
  entry: unknown;
  authorId?: string | null;
}

export type PushListener = (event: { type: string; sessionId: string; payload: unknown }) => void;

export class WorkspaceService {
  private pushListeners = new Set<PushListener>();

  constructor(private readonly db: NodePgDatabase<Record<string, never>>) {}

  onPush(cb: PushListener): () => void {
    this.pushListeners.add(cb);
    return () => this.pushListeners.delete(cb);
  }

  private push(type: string, sessionId: string, payload: unknown): void {
    for (const cb of this.pushListeners) {
      try {
        cb({ type, sessionId, payload });
      } catch {
        /* a broken subscriber never breaks the pipeline */
      }
    }
  }

  // ---------- workspaces ----------

  async createWorkspace(teamId: string, name: string, createdBy: string, description = ''): Promise<{ id: string }> {
    const [ws] = await this.db.insert(workspaces).values({ teamId, name, description, createdBy }).returning();
    // creator becomes manager
    await this.db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: createdBy, perm: 'manager' });
    return { id: ws!.id };
  }

  async addMember(workspaceId: string, userId: string, perm: WorkspacePerm): Promise<void> {
    await this.db
      .insert(workspaceMembers)
      .values({ workspaceId, userId, perm })
      .onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { perm } });
  }

  /** Membership lookup; returns null when the user has no access. */
  async memberPerm(workspaceId: string, userId: string): Promise<WorkspacePerm | null> {
    const [row] = await this.db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    return (row?.perm as WorkspacePerm) ?? null;
  }

  async assertCan(workspaceId: string, userId: string, action: WorkspaceAction): Promise<WorkspacePerm> {
    const perm = await this.memberPerm(workspaceId, userId);
    if (!perm) throw new WorkspaceError(403, 'EFORBIDDEN', '无权访问该工作区');
    if (!canWorkspace(action, perm)) throw new WorkspaceError(403, 'EFORBIDDEN', `权限不足（${perm} 不能 ${action}）`);
    return perm;
  }

  // ---------- shared sessions ----------

  async createSharedSession(workspaceId: string, ownerId: string, title: string, meta: Record<string, unknown> = {}): Promise<{ id: string }> {
    const [row] = await this.db.insert(sharedSessions).values({ workspaceId, ownerId, title, meta }).returning();
    return { id: row!.id };
  }

  /**
   * 幂等上行：同一 (session, seq) 重复提交静默成功（断线重放安全）。
   * 单条自增保护：seq 必须为当前最大 +1 或重复值（防跳号）。
   */
  async appendEntry(sessionId: string, authorId: string, entry: unknown, seq?: number): Promise<{ seq: number; duplicate: boolean }> {
    const [maxRow] = await this.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${sharedSessionEntries.seq}), -1)` })
      .from(sharedSessionEntries)
      .where(eq(sharedSessionEntries.sessionId, sessionId));
    const expected = Number(maxRow?.maxSeq ?? -1) + 1;
    const target = seq ?? expected;
    if (target > expected) throw new WorkspaceError(409, 'ESEQ', `seq 跳号：期望 ${expected}，收到 ${target}`);
    const inserted = await this.db
      .insert(sharedSessionEntries)
      .values({ sessionId, seq: target, entry: entry as object, authorId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return { seq: target, duplicate: true }; // replay — OK
    this.push('entry.appended', sessionId, { seq: target, entry });
    return { seq: target, duplicate: false };
  }

  /** 断线增量：since 之后的所有条目（按 seq 升序）。 */
  async entriesSince(sessionId: string, sinceSeq: number): Promise<Array<{ seq: number; entry: unknown; authorId: string | null }>> {
    const rows = await this.db
      .select()
      .from(sharedSessionEntries)
      .where(and(eq(sharedSessionEntries.sessionId, sessionId), gt(sharedSessionEntries.seq, sinceSeq)))
      .orderBy(asc(sharedSessionEntries.seq));
    return rows.map((r) => ({ seq: r.seq, entry: r.entry, authorId: r.authorId }));
  }

  // ---------- round lock ----------

  async acquire(sessionId: string, userId: string): Promise<LockAcquireResult> {
    const session = await this.mustGetSession(sessionId);
    const state = { lockUserId: session.lockUserId, lockHeartbeatAt: session.lockHeartbeatAt ? session.lockHeartbeatAt.getTime() : null };
    const result = acquireLock(state, userId, Date.now());
    if (result.granted) {
      await this.db
        .update(sharedSessions)
        .set({ lockUserId: userId, lockHeartbeatAt: new Date() })
        .where(eq(sharedSessions.id, sessionId));
      if (state.lockUserId !== userId) this.push('lock.acquired', sessionId, { userId });
    }
    return result;
  }

  async refreshHeartbeat(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.mustGetSession(sessionId);
    const state = { lockUserId: session.lockUserId, lockHeartbeatAt: session.lockHeartbeatAt ? session.lockHeartbeatAt.getTime() : null };
    if (!heartbeat(state, userId, Date.now())) return false;
    await this.db.update(sharedSessions).set({ lockHeartbeatAt: new Date() }).where(eq(sharedSessions.id, sessionId));
    return true;
  }

  /** Agent settled → holder releases; next queued speaker re-acquires. */
  async release(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.mustGetSession(sessionId);
    const state = { lockUserId: session.lockUserId, lockHeartbeatAt: session.lockHeartbeatAt ? session.lockHeartbeatAt.getTime() : null };
    if (!releaseLock(state, userId, Date.now())) return false;
    await this.db.update(sharedSessions).set({ lockUserId: null, lockHeartbeatAt: null }).where(eq(sharedSessions.id, sessionId));
    this.push('lock.released', sessionId, { userId });
    return true;
  }

  /** 90s 心跳超时清扫（定时调用）：返回释放的会话数。 */
  async sweepExpiredLocks(): Promise<number> {
    const cutoff = new Date(Date.now() - 90_000);
    const rows = await this.db
      .update(sharedSessions)
      .set({ lockUserId: null, lockHeartbeatAt: null })
      .where(and(sql`${sharedSessions.lockUserId} IS NOT NULL`, sql`${sharedSessions.lockHeartbeatAt} < ${cutoff}`))
      .returning();
    for (const r of rows) this.push('lock.released', r.id, { userId: r.lockUserId, reason: 'timeout' });
    return rows.length;
  }

  private async mustGetSession(sessionId: string) {
    const [row] = await this.db.select().from(sharedSessions).where(eq(sharedSessions.id, sessionId)).limit(1);
    if (!row) throw new WorkspaceError(404, 'ENOENT', '共享会话不存在');
    return row;
  }
}

export class WorkspaceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
