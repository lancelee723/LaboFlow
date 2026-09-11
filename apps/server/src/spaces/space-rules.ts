/**
 * T52.2 纯逻辑：团队空间权限矩阵（SPEC §3.1，服务端唯一裁判）。
 * IO（membership/override 读取、404 伪装语义）在 SpaceService；本文件全部为
 * 纯函数，由 space-rules.test.ts 穷举单测（无 DB）——HTTP 集成测试走的同一条
 * 判定路径。
 *
 * 矩阵（SPEC §3.1）：
 * | 动作                     | viewer | contributor            | manager | none |
 * | 浏览树/读文档/读评论      | ✓      | ✓                      | ✓       | ✗(404 伪装) |
 * | 评论/回复                | ✓      | ✓                      | ✓       | ✗ |
 * | 新建/编辑/上传/移动       | ✗      | ✓                      | ✓       | ✗ |
 * | 删除节点                 | ✗      | ✓（仅本人节点；他人=manager） | ✓  | ✗ |
 * | 接受/拒绝修订建议         | ✗      | ✓（仅自己请求的）        | ✓       | ✗ |
 * | 邀请/改档/移除/链接管理   | ✗      | ✗                      | ✓       | ✗ |
 */

export type SpacePerm = 'viewer' | 'contributor' | 'manager';
/** none = 显式 deny 档（仅出现在节点级覆盖里；服务端以 404 伪装其存在性，SPEC §4）。 */
export type NodePerm = SpacePerm | 'none';

export type SpaceAction =
  | 'view' // 浏览树 / 读文档 / 读评论 / 读事件
  | 'comment' // 评论 / 回复（含提出修订建议——同为「提议」级动作，不改正文）
  | 'edit' // 新建 / 编辑正文 / 上传 / 移动 / 恢复节点
  | 'delete' // 删除节点（contributor 仅限本人创建的；他人节点需 manager）
  | 'decideRevision' // 接受/拒绝修订建议（contributor 仅限自己请求的）
  | 'manage' // 成员/权限/邀请链接/空间设置
  ;

export interface SpacePermCtx {
  /** 动作对象是否由该用户创建（delete / decideRevision 的 owner 分支） */
  isOwner?: boolean;
}

/**
 * 判定一次动作是否被允许。perm 传 null 表示「不是空间成员」——与 'none' 同样
 * 一律 false（存在性伪装由服务层统一用 404 表达）。
 */
export function canSpace(action: SpaceAction, perm: NodePerm | null, ctx: SpacePermCtx = {}): boolean {
  if (perm === null || perm === 'none') return false;
  switch (action) {
    case 'view':
    case 'comment':
      return true; // viewer/contributor/manager 全允许（SPEC：评论 viewer ✓）
    case 'edit':
      return perm === 'contributor' || perm === 'manager';
    case 'delete':
    case 'decideRevision':
      if (perm === 'manager') return true;
      return perm === 'contributor' && Boolean(ctx.isOwner);
    case 'manage':
      return perm === 'manager';
  }
}

/**
 * 有效档位：节点级覆盖存在时整体取代空间档位（含 'none' 显式 deny）。
 * 空间成员档位为 null（非成员）时无论覆盖如何都不可见。
 */
export function effectivePerm(spacePerm: SpacePerm | null, override: NodePerm | null | undefined): NodePerm | null {
  if (!spacePerm) return null;
  return (override ?? spacePerm) as NodePerm;
}

/** 合法档位校验（API 入口用；'none' 仅允许出现在节点覆盖）。 */
export function isSpacePerm(v: unknown): v is SpacePerm {
  return v === 'viewer' || v === 'contributor' || v === 'manager';
}

export function isNodePerm(v: unknown): v is NodePerm {
  return isSpacePerm(v) || v === 'none';
}
