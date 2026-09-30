# legacy-frozen-repo：旧自研仓库归档（2026-09-30 迁入）

原位置 `/Users/lance/LaboFlow Desktop`（已删除）。这是 LaboFlow 在转向
PI-Desktop fork 路线**之前**的自研方案仓库，2026-09-09 冻结
（pivot 决策见 [`../00-pivot-decision.md`](../00-pivot-decision.md)）。

## 内容索引

| 条目 | 说明 |
|---|---|
| `frozen-repo-history.bundle` | **完整 git 历史**（含 tag `frozen-2026-09-09`）。恢复方式：`git clone frozen-repo-history.bundle 旧仓库` |
| `docs/` | PRD-LaboFlow v1.0 / SPEC / PLAN / P0–P4 验收报告 / ADR / 调研报告（对标产品、ZCode 行为规格基准、Cortex 逆向）/ 各轮今夜行动清单。**现行 laboflow-v2 文档引用的 FR-C/FR-S 条目编号出自这里的 PRD** |
| `参考文件/` | ZCode / Cortex UI 参考截图、bug 反馈截图（Phase5 调研素材） |
| `LaboFlow Logo_Square_1.svg` | 品牌资产源文件 |
| `FROZEN-README.md` / `LaboFlow Desktop.md` / bug 反馈清单 | 冻结期工作说明 |

## 状态声明

- 自研方案已废弃（`apps/server`、`apps/admin-console`、`packages/tsconfig` 已于
  2026-09-10 迁入本仓库，见 `02-org-integration-plan.md` Phase 2a 执行记录）。
- 服务端/管理台代码以**本仓库**为准；此归档仅供历史追溯与 PRD 条目引用。
- 原 `node_modules/`、`current/`（旧 UI 截图库）等未归档，随原目录一并删除。
