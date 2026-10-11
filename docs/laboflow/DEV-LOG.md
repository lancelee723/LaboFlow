# LaboFlow 开发记录

本文档记录 LaboFlow 从 PI-Desktop fork 以来的完整开发历程，包括已结束生命周期的 PLAN/SPEC 文档的完成情况和归档位置。

## 时间线

### 2026-09-09：产品转向决策

- 文档：[00-pivot-decision.md](00-pivot-decision.md)
- 决策：冻结自研 LaboFlow 客户端，以 PI-Desktop v0.14.5 硬 fork 为新核心。
- 品牌、组织层（登录/网关/配额）移植为新核心的第一优先增量。

### 2026-09-11：Phase 5 规划（六模块）

- 文档：[phase5/README.md](phase5/README.md)
- 将用户需求拆解为六个独立立项模块，每个模块配 PRD / PLAN / SPEC。

### 2026-09-12：Phase 5 验收

- 文档：[phase5/ACCEPTANCE-2026-09-12.md](phase5/ACCEPTANCE-2026-09-12.md)
- 五个模块代码级验收通过（模块 03 暂缓）。

### 2026-09-12（晚）：模块 06 L2 通道重建

- 文档：[phase5/06-ppt-assistant/PPT-MASTER-PLUGIN-DEVPLAN.md](phase5/06-ppt-assistant/PPT-MASTER-PLUGIN-DEVPLAN.md)
- PPT-Master L2 运行时通道按 DEVPLAN v1.1 三段式重建。

### 2026-09-30：上游同步 + T6.0

- 文档：[phase6/README.md](phase6/README.md)
- 上游 PI-Desktop v0.14.5 → v0.15.10（2335 提交）合并。
- T6.0 fork 能力重挂载完成；`feat/phase6-remainder` 分支 39 提交。

### 2026-10-02 ~ 10-04：T6.4 M 级缺口清零

- 文档：[archive/phase6-status/REMAINDER-TASKS-2026-10-02.md](archive/phase6-status/REMAINDER-TASKS-2026-10-02.md)
- 五个 M 级缺口全部修复并实机验证（通道账户持久化 / 存入空间 / 文件回传 / 树徽标 / 输出目的地）。
- 四轮实机验收（CDP + 真实输入 + OS 截屏）。
- IM通道改名九语言 + 侧栏图标移除 + PPT工作台 presentation 图标。

### 2026-10-11：Phase 7 PPT-Master 独立插件化

- 文档：[phase7-ppt-master/ACCEPTANCE.md](phase7-ppt-master/ACCEPTANCE.md)（设计见主检出
  `docs/laboflow/phase7-ppt-master/DESIGN.md`；决策记录 ADR 0041）
- 插件抽为独立仓库 `/Users/lance/laboflow-ppt-master`（`laboflow.ppt-master` v4.0.0，
  subtree 30 提交历史保留），工作台成为唯一确认面、自动打开、预览 daemon 禁令。
- 自动化门全绿（插件 78 测试 + PPT_IT 4/4 + S10 13/13；宿主 3513 tests fail=0 +
  ppt-host 7/7 + 打包冒烟）；实机 GUI 走查 8 项清单待用户运行。

## 已归档的 PLAN / SPEC 完成情况

| 文档 | 归档位置 | 完成状态 |
|---|---|---|
| 01-expert-center PLAN.md | archive/phase5-specs/01-expert-center/ | ✅ 全部 M 级 FR 落地 |
| 01-expert-center SPEC.md | archive/phase5-specs/01-expert-center/ | ✅ 架构决策已实施 |
| 02-team-collab PLAN.md | archive/phase5-specs/02-team-collab/ | ✅ M 级落地（HTML CRDT 为最新增补） |
| 02-team-collab SPEC.md | archive/phase5-specs/02-team-collab/ | ✅ |
| 03-mobile-command PLAN.md | archive/phase5-specs/03-mobile-command/ | ✅ cron/补跑/webhook/助理页/无人值守策略落地 |
| 03-mobile-command SPEC.md | archive/phase5-specs/03-mobile-command/ | ✅ |
| 04-im-channels PLAN.md | archive/phase5-specs/04-im-channels/ | ✅ 通道框架+三通道适配器+配置 UI 落地 |
| 04-im-channels SPEC.md | archive/phase5-specs/04-im-channels/ | ✅ |
| 05-knowledge-base PLAN.md | archive/phase5-specs/05-knowledge-base/ | ✅ MCP+内嵌浏览器+组织下发落地 |
| 05-knowledge-base SPEC.md | archive/phase5-specs/05-knowledge-base/ | ✅ |
| 06-ppt-assistant PLAN.md | archive/phase5-specs/06-ppt-assistant/ | ✅ L1+L2 双引擎+工作台落地 |
| 06-ppt-assistant SPEC.md | archive/phase5-specs/06-ppt-assistant/ | ✅ |

## 当前活跃文档

- **主线 PRD**：[PRD-LaboFlow-v2.md](PRD-LaboFlow-v2.md)
- **Phase 5 各模块 PRD**：[phase5/](phase5/)（M 级已全部落地，S/C 级部分开放）
- **Phase 6 README**：[phase6/README.md](phase6/README.md)（上游同步 + T6.0-T6.4 执行记录）
- **实机验收报告**：[acceptance/](acceptance/) 目录
