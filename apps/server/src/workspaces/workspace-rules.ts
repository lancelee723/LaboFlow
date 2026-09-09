/**
 * T2.6 pure logic: round-based lock state machine + workspace permission
 * matrix (PRD 4.1.13 / FR-S-09). IO lives in WorkspaceService; these rules
 * are unit-tested exhaustively — the 3-client concurrency E2E exercises the
 * same code through the HTTP surface.
 */

export type WorkspacePerm = 'viewer' | 'contributor' | 'manager';

/** 回合制锁：发言即加锁，Agent settled 或 90s 无心跳由服务端释放。 */
export const LOCK_HEARTBEAT_TIMEOUT_MS = 90_000;

export interface LockState {
  lockUserId: string | null;
  lockHeartbeatAt: number | null;
}

export type LockAcquireResult =
  | { granted: true }
  | { granted: false; reason: 'locked-by-other'; lockUserId: string; queuePositionHint: number };

export function acquireLock(state: LockState, userId: string, now: number): LockAcquireResult {
  // same user re-acquiring (refresh) always succeeds
  if (state.lockUserId === userId) return { granted: true };
  const expired =
    state.lockUserId === null ||
    state.lockHeartbeatAt === null ||
    now - state.lockHeartbeatAt > LOCK_HEARTBEAT_TIMEOUT_MS;
  if (expired) return { granted: true };
  return { granted: false, reason: 'locked-by-other', lockUserId: state.lockUserId as string, queuePositionHint: 1 };
}

/** Heartbeat refresh; only the lock holder may refresh. */
export function heartbeat(state: LockState, userId: string, now: number): boolean {
  if (state.lockUserId !== userId) return false;
  state.lockHeartbeatAt = now;
  return true;
}

/** Release: holder or server-side timeout sweep. */
export function releaseLock(state: LockState, userId: string | null, now: number): boolean {
  if (userId !== null && state.lockUserId !== userId) return false;
  if (userId === null && state.lockUserId !== null && state.lockHeartbeatAt !== null && now - state.lockHeartbeatAt <= LOCK_HEARTBEAT_TIMEOUT_MS) {
    return false; // not expired yet — sweep must not steal an active lock
  }
  state.lockUserId = null;
  state.lockHeartbeatAt = null;
  return true;
}

/** 是否可自动获得锁（用于排队发言在释放后自动转正的判定）。 */
export function isLockFree(state: LockState, now: number): boolean {
  return acquireLock(state, '__probe__', now).granted;
}

// ---------------- permission matrix (PRD 4.1.13 权限矩阵) ----------------

export type WorkspaceAction =
  | 'view' // 查看会话/文件
  | 'speak' // 发言/排队
  | 'upload' // 上传文件
  | 'agentWrite' // Agent 写入交付物
  | 'shareSession' // 分享新会话
  | 'renameOwn' // 重命名本人创建的
  | 'deleteOwn' // 删除本人创建的
  | 'manage' // 成员与权限管理、工作区设置
  ;

export function canWorkspace(action: WorkspaceAction, perm: WorkspacePerm, isOwner: boolean = false): boolean {
  switch (action) {
    case 'view':
      return true;
    case 'speak':
    case 'upload':
    case 'agentWrite':
      return perm === 'contributor' || perm === 'manager';
    case 'shareSession':
      return perm === 'contributor' || perm === 'manager';
    case 'renameOwn':
    case 'deleteOwn':
      return isOwner && (perm === 'contributor' || perm === 'manager') ? true : perm === 'manager';
    case 'manage':
      return perm === 'manager';
  }
}
