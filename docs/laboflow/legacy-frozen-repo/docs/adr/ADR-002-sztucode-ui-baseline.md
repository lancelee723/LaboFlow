# ADR-002：UI 验收基准变更为 SztuCode（Codex 形态）基准

- 状态：Accepted（2026-09-09，用户批准）
- 关联：PRD-LaboFlow 附录 C/D（被部分取代）、SPEC v1.2 §2、设计文档 `docs/specs/2026-09-09-sztucode-ui-port-design.md`

## 背景

PRD v1.2 确立的 UI 双基准为「ZCode 布局 × Cortex 视觉 token」（附录 C10/D1-D5）。实际推进中（tokens v3，2026-09-06 批准）团队已发现现方案在优雅度上不达预期。经对开源项目 SztuCode（MIT，/Users/lance/SztuCode，Codex Desktop 形态的完整开源复刻）的代码级调研，用户决策：**全面移植其前端 UI/UX 至 LaboFlow**。

## 决策

1. LaboFlow Desktop renderer 的布局结构、信息架构、组件形态、设计令牌、动效、文案基准统一改为 **SztuCode desktop**（快照：克隆于 2026-09-09，v0.2.0）。
2. PRD 附录 C 中「布局骨架、任务侧栏三视图、输入区排布、快捷键表以 ZCode 为准」的条款，凡与本设计冲突处，以本设计为准；附录 C5 快捷键表（⌘K/⌘B/⇧Tab 等）继续有效。
3. PRD 附录 D 的 Cortex 实测 token 表**不再作为** `packages/ui` 真相源；新真相源为设计文档 §2（tokens v4，源自 SztuCode appearance.css）。语义色保留区条款一并作废，改随 SztuCode 语义（绿成功/橙警告/红危险、权限「全部允许」橙色）。
4. 合规：SztuCode 为 MIT，允许复制修改；保留其版权声明于 notices；品牌资产（Logo/名称/hero 文案）用 LaboFlow 自有。PRD D4 红线（不拷贝 Cortex/ZCode 资产）不受影响、继续有效。
5. U 冲刺与后续 Gate 的截图比对基准从「ZCode/Cortex 各 8 屏」改为「SztuCode 四屏 + LaboFlow 对应屏」。

## 后果

- 正面：获得经实证的、优雅完整的桌面 Agent UI 形态；renderer 改造面可控（~5.4k 行）；MIT 无许可风险。
- 代价：PRD 附录 C/D 需在下次 PRD 修订（v1.3）中正式改写；已完成的 U.1 验收基线作废重做。
