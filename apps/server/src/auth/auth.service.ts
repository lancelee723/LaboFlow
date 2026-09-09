import { hash, verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users, auditLogs, virtualKeys, teams } from '../db/schema.js';
import { canManageUser, type Role } from '../teams/rbac.js';

/**
 * T2.2 认证与账户 (PRD 4.2.1 / FR-S-01/14):
 * - argon2id hashing (@node-rs/argon2, OWASP defaults)
 * - JWT double token: access 30min + refresh 14d (HS256)
 * - lockout: 5 consecutive failures → 15min
 * - must_change_password gate: 强制改密前除改密/登出外一律 403
 * - audit trail on every security event (追加写)
 */

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

export interface JwtPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  teamId: string | null;
  mustChangePassword: boolean;
}

export class AuthService {
  private jwtSecret: Uint8Array;

  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    secret: string,
  ) {
    this.jwtSecret = new TextEncoder().encode(secret);
    if (secret.length < 32) throw new Error('JWT_SECRET must be ≥32 chars');
  }

  // ---------- passwords ----------

  async hashPassword(plain: string): Promise<string> {
    if (plain.length < 10 || !/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
      throw new AuthError('密码强度不足：≥10 位且含字母和数字', 'WEAK_PASSWORD');
    }
    return hash(plain);
  }

  async verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
    return verify(passwordHash, plain);
  }

  // ---------- tokens ----------

  async issueTokens(user: AuthUser): Promise<JwtPair> {
    const base = { sub: user.id, username: user.username, role: user.role, teamId: user.teamId };
    const accessToken = await new SignJWT({ ...base, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(this.jwtSecret);
    const refreshToken = await new SignJWT({ ...base, typ: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('14d')
      .sign(this.jwtSecret);
    return { accessToken, refreshToken, accessExpiresIn: 1800 };
  }

  async verifyToken(token: string): Promise<{ sub: string; role: Role; teamId: string | null; typ: string }> {
    const { payload } = await jwtVerify(token, this.jwtSecret);
    if (typeof payload.sub !== 'string') throw new AuthError('bad token', 'EBADTOKEN');
    return {
      sub: payload.sub,
      role: payload.role as Role,
      teamId: (payload.teamId as string | null) ?? null,
      typ: String(payload.typ ?? 'access'),
    };
  }

  // ---------- login / lockout ----------

  async login(username: string, password: string): Promise<{ user: AuthUser; tokens: JwtPair | null; mustChangePassword: boolean }> {
    const row = (await this.db.select().from(users).where(eq(users.username, username)).limit(1))[0];
    const now = new Date();
    if (!row || row.disabledAt) {
      await this.audit(null, 'login.fail', username, { reason: 'no-user-or-disabled' });
      throw new AuthError('用户名或密码错误', 'EBADCREDS');
    }
    if (row.lockedUntil && row.lockedUntil > now) {
      await this.audit(row.id, 'login.locked', username, {});
      throw new AuthError('账户已锁定（连续失败过多），请 15 分钟后再试', 'ELOCKED');
    }
    const ok = await this.verifyPassword(row.passwordHash, password);
    if (!ok) {
      const failures = row.failedLoginCount + 1;
      const locked = failures >= LOCK_THRESHOLD;
      await this.db
        .update(users)
        .set({
          failedLoginCount: locked ? 0 : failures,
          lockedUntil: locked ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
        })
        .where(eq(users.id, row.id));
      await this.audit(row.id, 'login.fail', username, { failures, locked });
      throw new AuthError(locked ? '密码连续错误 5 次，账户锁定 15 分钟' : '用户名或密码错误', locked ? 'ELOCKED' : 'EBADCREDS');
    }
    await this.db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, row.id));
    const user: AuthUser = {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role as Role,
      teamId: row.teamId,
      mustChangePassword: row.mustChangePassword,
    };
    const tokens = await this.issueTokens(user);
    await this.audit(user.id, 'login.ok', username, {});
    return { user, tokens, mustChangePassword: row.mustChangePassword };
  }

  /** 强制改密流程：must_change_password 标志清除 + 重新发令牌。 */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<JwtPair> {
    const row = (await this.db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!row) throw new AuthError('user not found', 'ENOENT');
    if (!(await this.verifyPassword(row.passwordHash, currentPassword))) {
      await this.audit(userId, 'password.change.fail', row.username, {});
      throw new AuthError('当前密码错误', 'EBADCREDS');
    }
    const newHash = await this.hashPassword(newPassword); // strength-validated inside
    await this.db
      .update(users)
      .set({ passwordHash: newHash, mustChangePassword: false })
      .where(eq(users.id, userId));
    await this.audit(userId, 'password.change', row.username, {});
    const user: AuthUser = {
      id: row.id, username: row.username, displayName: row.displayName,
      role: row.role as Role, teamId: row.teamId, mustChangePassword: false,
    };
    return this.issueTokens(user);
  }

  /** 管理员重置密码：重置后再次强制改密 (PRD 4.2.1-2)。 */
  async adminResetPassword(actorId: string, targetUserId: string, newPassword: string): Promise<string> {
    const target = (await this.db.select().from(users).where(eq(users.id, targetUserId)).limit(1))[0];
    if (!target) throw new AuthError('user not found', 'ENOENT');
    const actor = (await this.db.select().from(users).where(eq(users.id, actorId)).limit(1))[0];
    if (!actor || !canManageUser({ role: actor.role as Role, teamId: actor.teamId ?? undefined }, { role: target.role as Role, teamId: target.teamId ?? undefined })) {
      throw new AuthError('无权重置该用户密码', 'EFORBIDDEN');
    }
    const newHash = await this.hashPassword(newPassword);
    const temp = newPassword ?? randomBytes(9).toString('base64url');
    await this.db
      .update(users)
      .set({ passwordHash: newHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, targetUserId));
    await this.audit(actorId, 'user.reset-password', target.username, {});
    return temp;
  }

  // ---------- virtual keys (T2.4 前置) ----------

  /** 签发虚拟 Key：明文只在返回瞬间出现，库中仅存 sha256。 */
  async issueVirtualKey(userId: string): Promise<{ plain: string }> {
    const plain = `vk_${randomBytes(24).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(plain).digest('hex');
    await this.db.insert(virtualKeys).values({ userId, tokenHash });
    await this.audit(userId, 'vkey.issue', '', {});
    return { plain };
  }

  async resolveVirtualKey(plain: string): Promise<{ userId: string } | null> {
    const tokenHash = createHash('sha256').update(plain).digest('hex');
    const row = (
      await this.db.select().from(virtualKeys).where(eq(virtualKeys.tokenHash, tokenHash)).limit(1)
    )[0];
    if (!row || row.revokedAt) return null;
    return { userId: row.userId };
  }

  async revokeVirtualKey(userId: string): Promise<void> {
    await this.db.update(virtualKeys).set({ revokedAt: new Date() }).where(eq(virtualKeys.userId, userId));
    await this.audit(userId, 'vkey.revoke', '', {});
  }

  // ---------- users (T2.2/T2.3 管理面) ----------

  async createUser(
    actorId: string,
    input: { username: string; displayName: string; password: string; role: Role; teamId?: string | null },
  ): Promise<AuthUser> {
    const actor = (await this.db.select().from(users).where(eq(users.id, actorId)).limit(1))[0];
    if (!actor) throw new AuthError('actor not found', 'ENOENT');
    if (actor.role === 'member') throw new AuthError('无权创建用户', 'EFORBIDDEN');
    if (actor.role === 'team_admin') {
      if (input.role !== 'member' || input.teamId !== actor.teamId) {
        throw new AuthError('团队管理员仅可创建本团队普通用户', 'EFORBIDDEN');
      }
    }
    if (input.role === 'team_admin' && input.teamId) {
      // 每团队唯一团队管理员（PRD 4.2.2）
      const existing = (
        await this.db.select().from(users).where(eq(users.teamId, input.teamId)).limit(50)
      ).filter((r) => r.role === 'team_admin');
      if (existing.length > 0) throw new AuthError('该团队已有团队管理员', 'ECONFLICT');
      await this.db.update(teams).set({ adminUserId: null }).where(eq(teams.id, input.teamId));
    }
    const passwordHash = await this.hashPassword(input.password);
    const inserted = (
      await this.db
        .insert(users)
        .values({
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          role: input.role,
          teamId: input.teamId ?? null,
          mustChangePassword: true,
        })
        .returning()
    )[0];
    if (input.role === 'team_admin' && input.teamId) {
      await this.db.update(teams).set({ adminUserId: inserted!.id }).where(eq(teams.id, input.teamId));
    }
    await this.audit(actorId, 'user.create', input.username, { role: input.role, teamId: input.teamId });
    return {
      id: inserted!.id,
      username: inserted!.username,
      displayName: inserted!.displayName,
      role: inserted!.role as Role,
      teamId: inserted!.teamId,
      mustChangePassword: inserted!.mustChangePassword,
    };
  }

  // ---------- audit ----------

  async audit(actorId: string | null, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.insert(auditLogs).values({ actorId, action, target, detail });
  }
}

export class AuthError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AuthError';
  }
}
