# PPT 工作台 v2 实施计划（M1–M3）

> **执行方式**：同 phase 7 —— 逐任务 TDD、每任务独立提交、任务后审查；实现全部在
> **插件仓库 `/Users/lance/laboflow-ppt-master`**（宿主零改动），完成后 pin v4.2.0 回 LaboFlow main。
> **设计依据**：WORKBENCH-V2-GAP-ANALYSIS-AND-PLAN.md（上游权威对照已固化其中）。

**Goal**: 工作台从"诊断面板"变为管线工作面——项目自动发现、Gate 表单化保真（Stage1 可编辑 + Stage2 完整字段/生产参数）、管线真实可见。

**Global Constraints**
- 上游契约不可破坏：`result.json` 用户提交值（含空串）即权威；read-once；字段名与上游 `final` 载荷逐一一致
- 载荷扩展向后兼容：旧 UI/旧确认载荷（无 overrides）必须继续工作
- 8 语言 i18n 全量；无绝对路径出现在默认 UI；单文件 <500 行（workbench.html 若超限拆 JS 到 renderer/workbench.js——view entry 允许多文件）
- 每任务出口：插件套件全绿（基线 86）+ 新增测试；提交信息英文

---

## M1 入口与术语（T1–T3）

### T1 桥通道 `ppt.listProjects`
- main.js `onPanelInvoke` 新增：扫 `workspace/projects/*`，每项返回
  `{name, projectDir, s1, s2, svgPages, svgFinal, exports, lastActivityMs}`（复用 projectListings + loadState）；
- 测试：临时工作区构造 5 阶段样本（无状态/仅 s1 submitted/双 confirmed+svg/含导出/空目录），断言摘要全对；无 projects 目录返回 `[]`。

### T2 项目选择器 UI
- `#preview` 顶行改为项目卡片下拉（`ppt.listProjects` 10s 轮询；bootstrap pending 命中则自动选中并跟随；否则选最近活动）；
- 绝对路径输入 + 载入按钮移入 `<details>高级</details>`；
- 测试：结构断言（选择器存在、路径框在 details 内、选择触发 loadProject）、i18n 键 ×8。

### T3 人话化 + 状态行 + 步进条真数据
- 标签：翻页预览→`页面预览`；空态→`AI 绘制的页面会出现在这里`；导出空态→`导出完成后在此列出`；
- 常驻状态行（步进条下方）：pending→`⏸ 正在等待你的确认`；否则项目 30s 内有文件变化→`⚙ AI 正在工作`；否则→`● 就绪`；
- 步进条两 Gate 节点显示 confirmedAt 短时间，点击展开该次确认摘要（resultSummary 已在状态机）；绘制节点显示 `已绘制 n 页`；
- 测试：文案键存在 ×8；状态行推导纯函数（pending/recent/idle 三态）单测。

## M2 Gate 保真（T4–T8）

### T4 `ppt.confirmStage` overrides 合并
- 载荷新增 `overrides?: Record<string,string>`；`confirmStage`（ppt-state.js）在写 result.json 时：白名单字段（Stage1=7 散文+canvas+模式；Stage2=生产参数+方向选择）以 overrides 覆盖推荐值，未列字段保持推荐值；空串照写（权威）；
- 测试：覆盖生效/未列保持/非白名单拒绝/空串落盘/read-once 不变；向后兼容（无 overrides 旧路径）。

### T5 stage2 生产参数入 confirm 流
- `ppt_stage_submit` 的 stage2 recommendations 接受生产参数（page_count、三 proactive 布尔、generation_mode、design_spec_depth、refine_spec、image_notes 等）并随 recommendations.stage2.json 落盘；
- `confirmStage(stage2)` 组装上游 `final` 形状：所选方向的 mode/visual_style(+_behavior)/color/icons/typography/image_strategy 展开至顶层 + 生产参数 + `selected` 索引；
- 测试：final 载荷与上游契约字段对照 ≥12 个（含三布尔默认 true/false/false、空 image_notes 保留 ""）。

### T6 Stage 1 英雄区表单化
- kv 表→表单：7 个 textarea（初值=建议值，label+可空提示）、canvas 单选（ppt169/ppt43+自定义框）、模式单选（自由设计/模板）；
- 确认按钮收集 `buildStage1Overrides(form)`（纯函数，导出供测试）→ confirmStage overrides；
- 测试：表单结构（7 textarea 断言）、buildStage1Overrides（改 1 字段→overrides 恰含该字段；全默认→空对象）、busy 态禁用。

### T7 Stage 2 方向卡完整化 + 生产参数区
- 方向卡：6 色板色块条（palette 各角色色块+HEX 角标）、字体行（中西文字体+body_size）、图像策略块（visual/mood/behavior）、行为描述 `<details>` 折叠；
- 生产参数区（卡组下方，独立于方向）：三 proactive 开关（默认按推荐）、页数输入、生成方式、规格深度 select、复审开关；
- `buildStage2Overrides(cardIndex, params)` 纯函数 → overrides（selected 索引 + 参数值）；
- 测试：卡内字段渲染断言（色块数=6/字体行/图像块）、buildStage2Overrides 映射、与 T5 final 组装联动。

### T8 模板模式 MVP（选择面）
- recommendations.stage1 含 `template_options` 时：模式单选激活「模板」选项并展开候选列表（来自 template_options，含 kind/name/摘要，多选 ≥1）；选择结果进 overrides（`template_mode:"templates"` + 选中根列表）；
- confirmStage 将选择写入 template_selection.json（现有写入点扩展）；安装链不在本期（确认后由对话指引安装，硬规则不变）；
- 测试：候选渲染、多选校验（未选禁用确认）、template_selection 内容。

## M3 管线可见（T9–T11）

### T9 管线时间线 + 当前动作行
- `deriveTimeline(state, listings, files)` 纯函数：节点序列 Gate1→Gate2→规格(design_spec+spec_lock 存在)→绘制(n/N)→质检(report 存在)→导出(有 pptx)，各带时间戳（state 时间/文件 mtime）；
- 渲染为纵向时间线（替换/融合现步进条）；"当前在做什么"行迁至此；
- 测试：6 阶段样本目录推导逐一断言（T1 样本复用+补质检样本）。

### T10 质检报告台内渲染
- 新桥通道 `ppt.readReport {projectDir}`：白名单读 `validation/svg_quality_report*.json` 与 `text_calibration.json`；
- 每页 pass/warning 列表（点条目跳转预览对应页）；
- 测试：通道白名单（越界路径拒绝）、渲染结构。

### T11 校准表回看 + 快速模式升格
- text_calibration.json → 逐角色表格（family/size/中英文速率/最长行）；
- 「豁免」升格为「快速模式」主按钮（带理由输入，文案对齐 Quick profile 语义）；
- 测试：表格渲染、按钮/理由流。

## 收尾（T12）
- 版本 4.2.0 + tag；LaboFlow main：bundle pin 刷新（version+sha256）+ fetch + 条件测试；
- 插件套件全量 + 宿主全量终验。

---

## 验收（含用户新增的实机验证）

1. **套件**：插件全部测试绿（基线 86 + 新增 ≥18）；宿主条件测试绿；
2. **实机验证（用户指定）**：**Computer-Use 技能**驱动 LaboFlow 实例——新建会话、模型选
   **GLM-5.3-Flash**、**先把会话权限模式切为「全自动」**（省 token、免逐条授权），以茂名精简稿跑全流程：
   `/` 选技能 → 工作台自动打开 → **Stage1 表单中直接修改「受众」字段**后确认 → Stage2 选方向 + 打开「演讲备注」开关后确认 → 绘制 → 质检报告台内可见 → 导出 → 工件登记；全程截图留档；
   *Computer-Use 若环境不可用（本会话有先例），降级为已验证的 CDP 驱动完成同一脚本，并在验收记录如实标注驱动方式*；
3. **推导一致性**：6 样本目录时间线推导 100%；
4. **契约对齐**：实机确认后的 result.json 与上游 final 字段抽查 ≥12 项一致（含用户覆盖值生效）；
5. 零行为回归：无 overrides 旧路径、F-2 续跑、自动打开均复验通过。

## 规模与顺序
T1→T12 串行（T4–T8 内部可两两并行审查）；预估 4–6 个工作日；M4（元素级批注/视觉复审入口/模板安装链）验收后另立项。

---

## V5 验收记录（2026-10-31，CDP 驱动 + 用户实测对话双轨）

**V5 修复项全部实机验证通过**（会话 4ca6dc9a = 用户实测对话；V5 验收会话走完整管线）：

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | svg_editor project_dir 透传（T1） | ✅ | Agent 首次调用即成功（`--live --daemon <dir>`），live_preview/lock.json 落盘，无键名猜测 |
| 2 | 会话↔项目绑定 + 空区折叠（T2） | ✅ | 新项目绑定后选择器跟随；大纲/备份空区隐藏 |
| 3 | 技能 chip 化（T3） | ✅ | "/"补全列表含 ppt-master chip；manifest.renderer 入布 |
| 4 | 胶囊→全自动（T4） | ✅ | 点击胶囊后权限模式 chip 显示「全自动」 |
| 5 | U3 指引 + 设计参数确认后继续 | ✅ | 用户回复后模型继续绘制（分块写入 P01/P02） |
| 6 | 导出走 ppt_script 门禁 | ✅ | 11 次 ppt_script（含 finalize/svg_to_pptx×4），Bash 门禁旁路 0 次；工件登记（exports op=export） |
| 7 | live-preview 批注回流 | ✅ | 编辑器 API 批注 → save-all → svg_output 带 data-edit-annotation + annotations.jsonl 追加 |
| 8 | 无 asktool / 无裸 daemon | ✅ | 全程 0 次；编辑器服务以 --live --daemon 托管启动且存活 |

**残余**：模型在"设计参数确认"输出后仍结束回合（需用户一句"继续"，U3 指引已使恢复路径明确）；RPC 宿主修复仍待立项。

## V6 补充（2026-11-01）：全自动改为会话级作用域

用户复审发现胶囊把**全局** defaultPermissionMode 改成 auto，泄漏到所有其他会话。
修复（v4.4.5，1ad39d2）：胶囊改调 configureActiveSession——home 屏无活动会话，store
落入 draftConfiguration，仅被本次胶囊创建的会话消费；全局 kv 不变（实测 ask / 会话 auto）。
