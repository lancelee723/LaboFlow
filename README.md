# LaboFlow

**本地优先的 AI 智能体桌面工作区，面向专业服务团队。**

LaboFlow 是 [PI-Desktop](https://github.com/vastsa/PI-Desktop)（v0.14.5）的硬 fork，在此基础上进行品牌自立与组织能力（团队管理 / 模型网关 / 共享工作区）扩展。底层智能体引擎为开源 [Pi](https://github.com/badlogic/pi-mono)（MIT）。

## 与上游的关系

| | 说明 |
|---|---|
| fork 基点 | PI-Desktop `v0.14.5` tag（保留上游 git 历史，`upstream` remote 指向上游仓库） |
| 上游策略 | 硬 fork + 择优 cherry-pick（不跟踪合并上游 main） |
| 许可证 | LGPL-3.0（继承自 PI-Desktop，见 `LICENSE`）；修改部分同样以 LGPL-3.0 发布 |
| 决策记录 | `docs/laboflow/00-pivot-decision.md` |
| 改造清单 | `docs/laboflow/01-rebrand-inventory.md` |
| 组织层计划 | `docs/laboflow/02-org-integration-plan.md` |

## 参与开发

环境要求：Node.js `>=22.19`、pnpm `>=10`、stable Rust 工具链。

```bash
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

校验改动：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

更多协议、规划、子智能体与 Electron E2E 细节，见上游架构文档：`docs/zh-CN/spec/`（随 fork 保留，暂未本地化改写）。

## 许可证

本项目基于 PI-Desktop，采用 **GNU Lesser General Public License v3.0** 授权，详见 [LICENSE](LICENSE)。对上游的修改以 `docs/laboflow/` 记录。
