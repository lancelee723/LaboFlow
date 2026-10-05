# PLAN：高级 PPT 制作助手（模块 06）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[SPEC](SPEC.md)、[Phase5 总览](../README.md) |
| 依赖 | 产物/交付物链既有；T56.7 组织模板包依赖 org bootstrap；T56.8 联动模块 01 |
| 工期估算 | 约 7–8 周（2 名工程师）；L1 两周保底，L2 为主菜 |

> 任务格式：**T56.x 任务名**（S/M/L/XL）— 验收标准。

---

## 批次 A：L1 基线回迁（M-P1，保底先落）

- **T56.1 SlidesService 移植（agentTools 形态）**（M）：以内置插件 `laboflow.slides` 落地（contributes: agentTools + skills + views，蓝本=`pi.browser` 插件结构）：`slides_plan`（大纲方案：结构化输出，版式枚举扩至 8 种）/ `slides_render`（逐页数据→中间表示）/ `slides_export`（pptxgenjs 导出可编辑 PPTX，vendor pptxgenjs 进插件依赖）；产物登记 kind=slides（版本链沿用）。蓝本=v1 `batch-i-services.ts` 的 `parseOutlineInput/renderSlideHtml/exportPptx`（升级点：LLM 大纲替代固定三页）。— 验收：FR-PPT-07/08；20 页 ≤60s；PPTX zip 结构断言测试移植通过；三端可编辑抽检。
- **T56.2 大纲确认流与预览翻页器**（M）：会话内 PPT 制作流：意图/指令触发 → 大纲方案卡（可编辑：增删页/改标题/调版式）→ 确认 → 逐页生成 → 翻页器（缩略图条+大图，页级重生成/删除/排序）→ 导出卡。— 验收：FR-PPT-01/02/04/06；E2E「主题→大纲→改两页→导出→产物卡→入交付物库」。
- **T56.3 引擎选择与产物通道**（S）：「精制/快速」切换（L2 未装时仅快速+引导）；导出目的地（本地/交付物库/团队空间）。— 验收：FR-PPT-03/05（L1 部分）。

**Gate M-P1**：L1 全链路可用（三端抽检）；无 Python 依赖（纯 JS 路径）。

## 批次 B：PPT-Master 集成（M-P2，主菜）

- **T56.4 vendor 与运行时引导**（L）：`resources/skills/ppt-master/` vendor（pin v6.3.2，含 attribution 文件与 VERSION 清单）；Python 运行时管理器 `ppt-runtime.ts`：检测 python3.10+/uv → venv 创建 → 依赖预检/安装向导（pip 镜像可配，wheel 离线包可选）→ **封禁 PyMuPDF/pandoc 路径**（requirements 裁剪 + 路由黑名单 + 启动自检断言）；设置页运行时状态卡。— 验收：FR-PPT-09/11；干净 macOS/Windows 机器从零引导成功；封禁自检（尝试 PDF 路由→明确报「LaboFlow 禁用」）；依赖清单归档（许可审计件）。
- **T56.5 管线受控暴露（agentTools 封装）**（L）：把脚本边界包装为工具：`ppt_plan`（Strategist：材料→design_spec+spec_lock，契约内容呈现用户确认）/ `ppt_batch_generate`（分批 SVG：前 5 页早门禁→质检→其余；进度事件+可中断）/ `ppt_finalize`（finalize_svg+total_md_split：讲者备注）/ `ppt_export`（svg_to_pptx+postflight 报告）/ `ppt_quality`（质量门禁，失败阻断导出）；工具参数白名单（禁 PDF 相关 flag）；工作目录隔离（scratch 下每 deck 独立目录）。— 验收：FR-PPT-10；mock+真实混合：20 页端到端 ≤20min、中断续跑、postflight 报告呈现；工具调用权限走既有审批。
- **T56.6 SKILL 适配与会话编排**（M）：技能装载（vendor SKILL.md 进技能目录，路由说明本地化附页）；系统提示词子句（引导模型优先走工具而非裸调脚本）；成本预估提示与预算中断（FR-PPT-16，联动 tool_budget）；L2 生成期间的会话占用语义（可后台，完成通知）。— 验收：FR-PPT-16/17；自然语言「做 PPT」正确路由 L2；预算中断保留已完成页。

**Gate M-P2**：真实研究材料→20 页咨询级 deck 端到端；双引擎对比样张评审（内部）；AGPL 封禁与 attribution 检查通过；Python 崩溃隔离测试。

## 批次 C：模板体系与工作台（M-P3）

- **T56.7 模板与蒸馏**（M）：自有 .pptx 模板上传→风格提取（PPT-Master Create Template 路由）→ 蒸馏资产存 `~/.laboflow/slide-templates/`；组织模板包：管理台发布（模板文件+风格契约）→ bootstrap `slideTemplates[]` 下发 → 成员默认可选。— 验收：FR-PPT-12/14；同一任务用自有模板生成风格一致（盲评）；组织下发 E2E。
- **T56.8 幻灯片工作台面板**（M）：工作面板新 tab：大纲树/页缩略图导航/版本历史/对比（复用产物版本链 diff）；与 L1/L2 双引擎产物兼容（中间表示统一：deck manifest）。— 验收：FR-PPT-18；面板操作与重生成联动。
- **T56.9 专家联动与增强项**（S）：PPT 制作师专家绑定 L2 工具（模块 01 FR-E-15 对应项）；native-charts/多画幅开关（FR-PPT-13）。— 验收：@PPT 制作师一键出初稿。
- **T56.10 收尾**（S）：三端抽检脚本化（PowerPoint/WPS/LibreOffice 自动打开校验清单）；用户手册「PPT 助手」章（含 Python 引导 troubleshooting）；i18n 复查。— 验收：Gate PPT 清单。

**Gate PPT（模块出口）**：见 PRD §5（含顾问盲评 ≥4/5、30 页零坏页抽检、许可合规三件套）。

## 里程碑总览

```
M-P1（约 2 周）  → L1 基线回迁（大纲流+预览+导出）        [批次 A]
M-P2（约 3.5 周）→ PPT-Master vendor + 运行时 + 管线封装  [批次 B] ← 主菜
M-P3（约 1.5–2 周）→ 模板/蒸馏/组织下发 + 工作台 + 联动   [批次 C] → Gate PPT
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| Python 环境碎片（用户机器差异） | uv + venv 引导为正路；wheel 离线包兜底；L1 永远可用（无 Python 依赖）保底 |
| PPT-Master 上游漂移/单人维护 | pin 版本 vendor（不跟踪 main）；升级=独立 PR 全量回归；适配层隔离（工具封装，SKILL 不直接进系统提示词主干） |
| 长上下文模型不可得（组织网关无强模型） | 引擎前置检查：模型上下文 <128k 时 L2 降级建议（分批更小/建议 L1）；质量风险在 UI 明示 |
| AGPL 传染（PyMuPDF 意外启用） | 三重封禁（依赖裁剪/路由黑名单/启动断言）+ Gate 许可检查脚本 |
| 中文字体/排版在 SVG→PPTX 的质量 | 验收含中文重排用例（长标题/竖排/标点悬挂）；badcase 反馈进 P3 迭代 |
