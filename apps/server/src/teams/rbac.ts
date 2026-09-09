/**
 * T2.3 RBAC — the PRD 4.2.2 permission matrix as pure functions.
 * Roles: sys_admin | team_admin | member. 单租户：一次部署 = 一个组织。
 */

export type Role = 'sys_admin' | 'team_admin' | 'member';

export type RbacAction =
  | 'team.create'
  | 'team.delete'
  | 'team.assignAdmin'
  | 'team.manageUsers' // 本团队内用户增删改、重置密码
  | 'user.createAny'
  | 'user.resetPasswordAny'
  | 'workspace.create'
  | 'workspace.delete'
  | 'workspace.configureMembers'
  | 'channel.manage' // 模型上游渠道管理
  | 'quota.system'
  | 'quota.team'
  | 'library.publish'
  | 'audit.viewAll'
  | 'audit.viewTeam';

interface Ctx {
  actorRole: Role;
  /** actor's team (required for team-scoped actions) */
  actorTeamId?: string;
  targetTeamId?: string;
  /** for user-management actions: the role of the user being managed */
  targetRole?: Role;
  isTargetTeamAdmin?: boolean;
}

const ROLE_RANK: Record<Role, number> = { member: 1, team_admin: 2, sys_admin: 3 };

export function can(action: RbacAction, ctx: Ctx): boolean {
  const { actorRole } = ctx;
  const sameTeam = ctx.targetTeamId === undefined || ctx.actorTeamId === ctx.targetTeamId;
  switch (action) {
    // 团队 CRUD、指定/改任团队管理员：仅系统管理员
    case 'team.create':
    case 'team.delete':
    case 'team.assignAdmin':
      return actorRole === 'sys_admin';

    // 本团队内用户增删改：系统管理员任意；团队管理员限本团队
    case 'team.manageUsers':
      if (actorRole === 'sys_admin') return true;
      if (actorRole === 'team_admin') {
        return sameTeam && !ctx.isTargetTeamAdmin && (ctx.targetRole === undefined || ctx.targetRole === 'member');
      }
      return false;

    case 'user.createAny':
    case 'user.resetPasswordAny':
      return actorRole === 'sys_admin';

    // 工作区：系统管理员任意；团队管理员限本团队
    case 'workspace.create':
    case 'workspace.delete':
    case 'workspace.configureMembers':
      if (actorRole === 'sys_admin') return true;
      return actorRole === 'team_admin' && sameTeam;

    // 模型上游渠道 / 系统级配额：仅系统管理员
    case 'channel.manage':
    case 'quota.system':
      return actorRole === 'sys_admin';

    // 本团队配额：系统管理员或本团队管理员；不得宽于系统级在 API 层校验
    case 'quota.team':
      return actorRole === 'sys_admin' || (actorRole === 'team_admin' && sameTeam);

    case 'library.publish':
      return actorRole === 'sys_admin' || actorRole === 'team_admin';

    case 'audit.viewAll':
      return actorRole === 'sys_admin';

    case 'audit.viewTeam':
      return actorRole === 'sys_admin' || (actorRole === 'team_admin' && sameTeam);
  }
}

/** Guard helper: 管理动作的层级约束 — a lower-ranked actor never manages an equal/higher one. */
export function canManageUser(actor: { role: Role; teamId?: string }, target: { role: Role; teamId?: string }): boolean {
  if (actor.role === 'member') return false; // 普通用户无用户管理权
  if (ROLE_RANK[actor.role] < ROLE_RANK[target.role]) return false;
  if (actor.role === 'team_admin') {
    // 团队管理员不可管理团队管理员本人；不可跨团队
    return target.role === 'member' && actor.teamId !== undefined && actor.teamId === target.teamId;
  }
  return true; // sys_admin
}
