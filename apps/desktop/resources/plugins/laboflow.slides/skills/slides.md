---
name: slides-l1
description: When the user asks for a PPT/slide deck (做PPT/slide/汇报材料) or asks to export a deck, use the slides tools: draft an outline with action titles, normalize it with slides_plan, get user confirmation, then export with slides_export.
---

# Slides L1（快速引擎）

工具全名（注册后带插件前缀）：

- `plugin_laboflow_slides_slides_plan` — 规范化/校验你起草的大纲
- `plugin_laboflow_slides_slides_export` — 导出可编辑 .pptx

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

- 用户未确认大纲前**不得**调用 `slides_export`。
- 不要把整份演讲稿塞进页面：每页 ≤5 条要点，每条 ≤2 行；细节放 speakerNotes。
- 数字必须有来源标注（页内或备注），无法核实的写「待核实」。
