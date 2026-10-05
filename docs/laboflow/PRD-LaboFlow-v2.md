# LaboFlow v2 主线 PRD

> 整合自 Phase 5 六模块 PRD（详见 archive/phase5-specs/ 中各模块的原始 PLAN/SPEC）。
> 各模块的详细需求仍以 phase5/ 目录下对应模块的 PRD 为准，本文档为总纲索引。

## 产品定位

LaboFlow 是面向咨询团队的 AI 桌面工作台，基于 PI-Desktop fork（v0.15.10）。

## 六大模块

| # | 模块 | PRD | 状态 |
|---|---|---|---|
| 01 | 专家与专家团 | [PRD](phase5/01-expert-center/PRD.md) | ✅ 已落地（M 级全通过） |
| 02 | 团队空间 | [PRD](phase5/02-team-collab/PRD.md) | ✅ 已落地（HTML CRDT 协同为最新增补） |
| 03 | 手机远程指挥与定时任务 | [PRD](phase5/03-mobile-command/PRD.md) | ✅ 已落地（cron/补跑/webhook/助理页） |
| 04 | IM 通道 | [PRD](phase5/04-im-channels/PRD.md) | ✅ 已落地（通道持久化+配置 UI；真实租户联调为外部项） |
| 05 | 知识库 | [PRD](phase5/05-knowledge-base/PRD.md) | ✅ 已落地（MCP+内嵌浏览器；WeKnora e2e 为外部项） |
| 06 | PPT 助手 | [PRD](phase5/06-ppt-assistant/PRD.md) | ✅ 已落地（L1+L2 双引擎+工作台；L2 长管线受模型约束） |

## 架构决策

见 [00-pivot-decision.md](00-pivot-decision.md)（PI-Desktop fork 决策）和 [adr/](../adr/) 目录。

## 验收记录

- [Phase 5 验收](phase5/ACCEPTANCE-2026-09-12.md)
- [Phase 6 T6.0 验收](archive/phase6-status/E2E-ACCEPTANCE-2026-09-30.md)
- 实机验收 Round 1–4：[acceptance/](acceptance/) 目录
