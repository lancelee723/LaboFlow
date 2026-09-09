import { describe, it, expect } from 'vitest';
import { can, canManageUser, type Role } from './rbac.js';

/** PRD 4.2.2 权限矩阵逐条（FR-S-02/03 验收基准）。 */

const ctx = (role: Role, over: Partial<Parameters<typeof can>[1]> = {}): Parameters<typeof can>[1] => ({
  actorRole: role,
  ...over,
});

describe('RBAC matrix (T2.3, PRD 4.2.2)', () => {
  it('团队 CRUD/指定管理员：仅系统管理员', () => {
    expect(can('team.create', ctx('sys_admin'))).toBe(true);
    expect(can('team.create', ctx('team_admin'))).toBe(false);
    expect(can('team.delete', ctx('member'))).toBe(false);
    expect(can('team.assignAdmin', ctx('team_admin'))).toBe(false);
  });

  it('本团队用户管理：sys_admin 任意；team_admin 限本团队且不可动管理员', () => {
    expect(can('team.manageUsers', ctx('sys_admin'))).toBe(true);
    expect(
      can('team.manageUsers', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't1', targetRole: 'member' })),
    ).toBe(true);
    expect(
      can('team.manageUsers', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't2', targetRole: 'member' })),
    ).toBe(false);
    expect(
      can('team.manageUsers', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't1', targetRole: 'team_admin' })),
    ).toBe(false);
    expect(can('team.manageUsers', ctx('member'))).toBe(false);
  });

  it('工作区：sys_admin 任意；team_admin 限本团队；member 无', () => {
    expect(can('workspace.create', ctx('sys_admin'))).toBe(true);
    expect(can('workspace.configureMembers', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't1' }))).toBe(true);
    expect(can('workspace.delete', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't2' }))).toBe(false);
    expect(can('workspace.create', ctx('member'))).toBe(false);
  });

  it('渠道与系统级配额：仅系统管理员；团队级配额限本团队管理员', () => {
    expect(can('channel.manage', ctx('sys_admin'))).toBe(true);
    expect(can('channel.manage', ctx('team_admin'))).toBe(false);
    expect(can('quota.system', ctx('team_admin'))).toBe(false);
    expect(can('quota.team', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't1' }))).toBe(true);
    expect(can('quota.team', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't2' }))).toBe(false);
  });

  it('组织资产发布与审计视图', () => {
    expect(can('library.publish', ctx('team_admin'))).toBe(true);
    expect(can('library.publish', ctx('member'))).toBe(false);
    expect(can('audit.viewAll', ctx('sys_admin'))).toBe(true);
    expect(can('audit.viewAll', ctx('team_admin'))).toBe(false);
    expect(can('audit.viewTeam', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't1' }))).toBe(true);
    expect(can('audit.viewTeam', ctx('team_admin', { actorTeamId: 't1', targetTeamId: 't2' }))).toBe(false);
  });

  it('canManageUser：低级不可管高级；team_admin 只管本团队 member', () => {
    expect(canManageUser({ role: 'team_admin', teamId: 't1' }, { role: 'team_admin', teamId: 't1' })).toBe(false);
    expect(canManageUser({ role: 'team_admin', teamId: 't1' }, { role: 'member', teamId: 't2' })).toBe(false);
    expect(canManageUser({ role: 'team_admin', teamId: 't1' }, { role: 'member', teamId: 't1' })).toBe(true);
    expect(canManageUser({ role: 'sys_admin' }, { role: 'team_admin' })).toBe(true);
    expect(canManageUser({ role: 'member', teamId: 't1' }, { role: 'member', teamId: 't1' })).toBe(false);
  });
});
