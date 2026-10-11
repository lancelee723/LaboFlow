# ADR 0041: PPT-Master 插件抽为独立仓库 laboflow.ppt-master 并收敛工作台交互

- Status: Implemented candidate
- Related: ADR 0040（单引擎）, ADR 0077（asktool）, ADR 0104（插件工作面板视图）,
  docs/laboflow/phase7-ppt-master/DESIGN.md（§3 决策表、§5 交互契约、§8 分发兼容）

## Context

PPT-Master 插件此前捆绑在 LaboFlow 仓库内
（`apps/desktop/resources/plugins/laboflow.slides`），宿主侧存在三处耦合：
`laboflow/slides-artifacts.ts` 硬编码插件 ID 与工具名、`builtin-experts.ts`
直接引用技能名、插件测试与打包流程全部位于宿主仓库。插件无法独立开发、
独立发版、独立测试。

PPT Test 会话取证（会话 `380f7277`，2026-10-08，93 事件全量分析）同时暴露
交互层缺陷：工作台从不自动打开（插件 API 只能开浮动面板，无停靠视图 API）；
两阶段确认被 Agent 就地降级为 asktool 模态，工作台确认面全程未参与；工作台
本身是面向开发者的"诊断仪表"；会话最终因单轮累计重 Python 调用耗尽宿主 RPC
预算、以及上游"实时预览服务"前台 daemon 挂死 shell 而死亡。

## Decision

1. **独立仓库**：插件抽为 `/laboflow-ppt-master` 独立仓库，经
   `git subtree split` 抽取，30 个提交历史完整保留（`PROVENANCE.md` 记录
   溯源区间；vendored 上游语料的历史链保持完整以满足 AGPL 审计）。
2. **插件 ID 与版本**：`laboflow.ppt-master`，版本 4.0.0（ID 变更为破坏性
   变更，故升 major；数据目录随之换新，旧 `laboflow.slides` 目录成孤儿，
   不阻塞、后续低优清理）。
3. **构建期 pinned 分发**：发行版继续开箱即用。`apps/desktop/plugins.bundle.json`
   锁定每个捆绑插件（id / version / source / sha256，manifest 级哈希；
   整树哈希暂缓），`scripts/fetch-bundled-plugins.mjs`（`fetch:plugins`）
   校验 manifest id+version+sha256 后复制进 `resources/plugins/<id>/`，
   并前置接入 `pack` / `dist*`。发行 CI 的 release-zip URL 源暂缓（当前
   source 为本地检出路径）。插件自带 wheelhouse 随发布产物携带，宿主不再
   单独构建。
4. **宿主新 API `pi.ui.openView`**：插件可打开自己 contributes 的停靠工作
   面视图；权限复用既有 `ui.view`，view id 必须属于本插件 manifest 声明，
   越界/未声明拒绝。插件侧特性检测调用（API 缺失记日志、工具结果不受影响）。
   工作台自动打开挂在首个管线工具调用（`ppt_master_status`）上，覆盖 `/`
   显式选择与自然语言路由两条路径。
5. **确认面收敛为单一工作台**（A 面）：两阶段确认必须经 `ppt_stage_submit`
   提交并在工作台完成；技能前言契约**禁止** asktool / 对话内确认 / 代用户
   确认 / 静默视为确认，对话只呈现方案全文 + 指路后停住。浮动确认卡整体
   退役（manifest `ui.panel`、`renderer/confirm-card.html`、
   `openConfirmCard` 命令移除），工作台成为插件唯一 UI 面。
6. **预览 daemon 禁令**：禁止以任何形式启动上游"实时预览服务"daemon；
   实时预览由工作台 SVG 翻页承担。
7. **宿主耦合点降级**：`slides-artifacts.ts` 改跟 `laboflow.ppt-master`，
   插件缺席时 no-op（原本就是 best-effort）；`builtin-experts.ts` 的
   「PPT制作师」技能绑定在插件缺席时自然失效；捆绑校验测试条件化（无
   vendored 副本时 skip 而非 fail）。

## Consequences

- 仓库协调成本 +1：PPT 功能的 issue / PR / 发版节奏独立于宿主仓库；
  宿主发行链新增一步 `fetch:plugins`（pinned 拉取 + 哈希校验）。
- ID 变更使升级用户一次性重建 Python venv（离线 wheelhouse 预置，后台
  静默完成，用户无感）；技能路径一次性迁移为
  `/laboflow.ppt-master/ppt-master`；历史会话转录不受影响（工具调用记录
  是文本）。
- Agent 绕过 `ppt_stage_submit` 的复发风险由三重钉约束：前言硬规则 +
  工具描述 + 插件仓库前言契约测试；实机验收专门检查。
- `pi.ui.openView` 形状按可回馈 PI-Desktop 上游设计，不携带 PPT 语义。

## Alternatives

- **git submodule 挂载**：并行 agent 场景下 worktree / CI / 部分克隆的
  同步负担重，放弃（DESIGN §3）。
- **不捆绑、用户首次使用自行安装**：开箱即用体验倒退，与 G5 冲突，放弃。
- **中立命名 `pi.*`**：名实不符，且有冒充上游 PPT-Master / pi.dev 之嫌，
  放弃。
