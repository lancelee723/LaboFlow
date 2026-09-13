---
name: slides-l1
description: When the user asks for a PPT/slide deck (做PPT/slide/汇报材料) or asks to export a deck, use the slides tools: draft an outline with action titles, normalize it with slides_plan, get user confirmation, then export with slides_export.
---

# Slides L1（快速引擎）

工具全名（注册后带插件前缀）：

- `plugin_laboflow_slides_slides_plan` — 规范化/校验你起草的大纲
- `plugin_laboflow_slides_slides_export` — 导出可编辑 .pptx

## 引擎路由（先读这里）

两条引擎，按需求选一条；拿不准时问一句用户要"快速"还是"精品"：

- **本技能（L1 快速引擎）**：结构清晰的大纲式 PPTX，秒级导出，元素为原生文本框/表格。适合：快速起草、先看结构、内容为主不在乎视觉、用户明说"快速/简单/先出个初稿"。
- **ppt-master 技能（L2 精制引擎）**：见 `ppt-master` 技能。适合：用户要"麦肯锡风格/咨询风格/精品/好看/有设计感/信息密度大/图表化"、品牌模板、或对单页视觉有明确要求。**用户点名"精品/麦肯锡"却只走 L1 是历史事故根源（2026-09 会话取证），务必路由正确。**

路由到 L2 后一切以 ppt-master 技能的规程为准（先 `ppt_master_status` 取路径）。

## 工作流（两段确认，先大纲后生成）

1. **起草大纲**：基于主题与会话材料，产出大纲草案。规则：
   - 页标题必须是**行动标题**（完整判断句，如「华北市场三年内将洗牌至三强」），禁止名词短语；
   - 一页一信息：每页只回答一个问题；
   - 结构：title 开篇 →（可选）执行摘要 → 论证页群 → 风险/下一步 → end 收尾；
   - 版式按内容选用：bullets（默认）、data（2–4 个关键指标卡）、matrix（2×2 象限）、compare（并排对比列）、timeline（里程碑）、quote（金句页）；
   - 每页写 speakerNotes（1–3 句口播稿）。
2. **规范化**：调用 `slides_plan`（传 topic + 你起草的 outline JSON）。它会修复结构、给出质量提示（如"标题偏短语"）。把规范化后的大纲呈现给用户逐页确认。
3. **按反馈修改**：用户要求调整时直接改大纲，可再次调用 `slides_plan` 校验。
4. **导出**：用户确认后调用 `slides_export`（deckTitle + pages + 可选 theme.accent）。产出为原生可编辑 PPTX（文本框/表格，PowerPoint/WPS/LibreOffice 直接编辑）。

## 硬性约束

- 用户未确认大纲前**不得**调用 `slides_export`。"用户提了详细要求"不等于确认——必须把大纲呈现并得到显式回复。
- 不要把整份演讲稿塞进页面：每页 ≤5 条要点，每条 ≤2 行；细节放 speakerNotes。
- 数字必须有来源标注（页内或备注），无法核实的写「待核实」。
