# 决策记录 00：产品转向——以 PI-Desktop fork 为新核心

- 日期：2026-09-09
- 状态：已接受
- 决策人：lance

## 背景

LaboFlow 原为自研客户端（Electron + React，内嵌 `@earendil-works/pi-coding-agent` 0.85.0）+ 自研服务端（NestJS）。自研客户端已完成 P1 A–F、P2 T2.1–T2.5、P4 验收（314 测试通过），但 UI 打磨与桌面级工程坚固度（断点续跑、审查快照、发布工程）距专业级产品有明显差距，为此启动了 P5-UI 渲染层重写计划（0/18 任务）。

调研发现开源项目 PI-Desktop（vastsa/PI-Desktop，v0.14.5，LGPL-3.0）与 LaboFlow 同源（均基于 Pi 引擎 0.85.x），且已实现高质量的桌面 harness：10.5 万行产品代码、4.1 万行测试、242 个 Rust 测试、7 套 E2E、三平台签名发布流水线、45k 行成熟渲染层。

## 决策

1. **冻结自研 LaboFlow 客户端**（冻结点：`LaboFlow Desktop` 仓库 tag `frozen-2026-09-09`）。
2. **以 PI-Desktop v0.14.5 硬 fork 为新 LaboFlow 核心**，保留上游 git 历史，fork 策略为「硬 fork + 择优 cherry-pick」，不跟踪合并上游 main。
3. **品牌自立**：更名 LaboFlow，替换 appId/图标/更新源/品牌文案（清单见 01-rebrand-inventory.md）。
4. **嫁接组织能力**（团队管理/登录/模型网关对接/共享工作区）：复用已冻结仓库的 `apps/server`（NestJS）与 `apps/admin-console`，客户端侧新写组织层（计划见 02-org-integration-plan.md）。

## 范围裁决（明确不做 / 沿用上游）

| 事项 | 裁决 |
|---|---|
| 权限语义 | **沿用 PI-Desktop 三档语义**（ask / accept-edits / auto + inherit），不移植 LaboFlow 的 ZCode 四档语义 |
| 调度 | **沿用 PI-Desktop 现有调度**（manual/hourly/daily/weekly），不移植 croner 语义 |
| 智能特性（Memory/Wiki/Slide/深度研究/产物版本链等） | **暂不移植**，后续按需评估 |
| 组织客户端（登录/网关渠道/配额/共享工作区） | **必须移植**，为新核心的第一优先增量 |

## 后果

- 正面：白赚 45k 行成熟渲染层与桌面级 harness 坚固度；P5-UI 的 18 任务工作量作废；组织层成为唯一自研增量，重心与差异化（团队管理、后续知识库）一致。
- 代价：客户端功能水位阶段性回退（智能特性清零）；LGPL-3.0 传染客户端修改（对外发布须附源；已接受）；上游漂移（以 cherry-pick 节奏对冲）；后续如需改权限引擎须具备 Rust 能力。
- 数据与合规：`app.setName("LaboFlow")` 后 userData 使用全新目录（`~/Library/Application Support/LaboFlow`），与上游 PI-Desktop 数据完全隔离；LGPL 合规三件套=保留 LICENSE 与版权声明、发布时附修改说明（本目录）、修改部分以 LGPL 发布。
