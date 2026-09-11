import { describe, expect, it } from 'vitest';
import { canSpace, effectivePerm, isNodePerm, isSpacePerm, type NodePerm, type SpaceAction } from './space-rules.js';

/**
 * T52.2 权限矩阵穷举单测（SPEC §3.1）：4 档（含 none/null）× 6 动作 × owner
 * 全组合 + effectivePerm 覆盖语义。无 DB。
 */

const PERMS: Array<NodePerm | null> = ['viewer', 'contributor', 'manager', 'none', null];
const ACTIONS: SpaceAction[] = ['view', 'comment', 'edit', 'delete', 'decideRevision', 'manage'];

/** 期望矩阵（独立于实现重写一遍，防止同构实现自证）： */
function expectedCan(perm: NodePerm | null, action: SpaceAction, isOwner: boolean): boolean {
  if (perm === null || perm === 'none') return false;
  if (perm === 'manager') return true;
  if (action === 'view' || action === 'comment') return true; // viewer ✓（SPEC §3.1）
  if (perm === 'contributor') {
    if (action === 'edit') return true;
    if ((action === 'delete' || action === 'decideRevision') && isOwner) return true; // 仅本人节点/自己请求的
  }
  return false;
}

describe('canSpace — 穷举权限矩阵（SPEC §3.1）', () => {
  for (const perm of PERMS) {
    for (const action of ACTIONS) {
      for (const isOwner of [false, true]) {
        const label = `${perm ?? 'null'} × ${action}${isOwner ? ' (owner)' : ''}`;
        it(label, () => {
          expect(canSpace(action, perm, { isOwner })).toBe(expectedCan(perm, action, isOwner));
        });
      }
    }
  }

  it('viewer 可浏览可评论，不能编辑/删除/决定/管理', () => {
    expect(canSpace('view', 'viewer')).toBe(true);
    expect(canSpace('comment', 'viewer')).toBe(true);
    expect(canSpace('edit', 'viewer')).toBe(false);
    expect(canSpace('delete', 'viewer', { isOwner: true })).toBe(false);
    expect(canSpace('decideRevision', 'viewer', { isOwner: true })).toBe(false);
    expect(canSpace('manage', 'viewer')).toBe(false);
  });

  it('contributor 可编辑、可删本人节点；删他人节点/决定他人建议需 manager', () => {
    expect(canSpace('edit', 'contributor')).toBe(true);
    expect(canSpace('delete', 'contributor', { isOwner: true })).toBe(true);
    expect(canSpace('delete', 'contributor', { isOwner: false })).toBe(false);
    expect(canSpace('decideRevision', 'contributor', { isOwner: true })).toBe(true);
    expect(canSpace('decideRevision', 'contributor', { isOwner: false })).toBe(false);
    expect(canSpace('manage', 'contributor')).toBe(false);
  });

  it('none（显式 deny）与非成员（null）全拒绝且与 owner 无关', () => {
    for (const action of ACTIONS) {
      expect(canSpace(action, 'none', { isOwner: true })).toBe(false);
      expect(canSpace(action, null, { isOwner: true })).toBe(false);
    }
  });
});

describe('effectivePerm — 节点覆盖语义', () => {
  it('无覆盖时沿用空间档位', () => {
    expect(effectivePerm('viewer', undefined)).toBe('viewer');
    expect(effectivePerm('manager', null)).toBe('manager');
  });

  it('有覆盖时整体取代（含 none 显式 deny）', () => {
    expect(effectivePerm('manager', 'none')).toBe('none');
    expect(effectivePerm('viewer', 'manager')).toBe('manager');
    expect(effectivePerm('contributor', 'viewer')).toBe('viewer');
  });

  it('非成员（null）永远不可见，覆盖也无法提权', () => {
    expect(effectivePerm(null, 'manager')).toBeNull();
    expect(effectivePerm(null, undefined)).toBeNull();
  });

  it('档位守卫', () => {
    expect(isSpacePerm('viewer')).toBe(true);
    expect(isSpacePerm('none')).toBe(false);
    expect(isNodePerm('none')).toBe(true);
    expect(isNodePerm('manager')).toBe(true);
    expect(isNodePerm('owner')).toBe(false);
  });
});
