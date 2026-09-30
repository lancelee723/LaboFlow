# 基线截图库（附录 D-D5）

- `baseline/`：ZCode 与 Cortex 各 8 屏参考截图（workbench/session/approval-card/command-palette/settings/marketplace/task-views/dark-mode），命名 `<product>-<screen>.png`；`manifest.json` 登记每屏来源与采集时间。
- `current/`：LaboFlow 同屏截图 `<screen>.png`。
- 比对执行：`node apps/desktop/scripts/compare-baseline.mjs`。
- 验收标准：区域尺寸差 ≤4px、色值差 ≤2%（ΔE≈3）、图标形制一致、间距基数一致；通过率 ≥90%。
- **截图需要屏幕录制权限，由产品负责人提供**；脚本就绪后放入即跑。

## 状态更新（2026-09-06 09:45）

- ✅ **`current/` 8 屏已由 ZCode 自动采集**（真实运行的应用：`pnpm dev` + mock 模型端到端对话）：
  workbench / session / approval-card / command-palette / settings / marketplace / task-views / dark-mode
- 采集方式：macOS `screencapture -l<windowId>`（纯窗口、Retina 全分辨率）；交互经辅助功能 API 驱动（发送消息 → 审批 → 放行 → 回复，主题/视图/设置切换均为真实点击）。
- 采集中发现并即时修复：工具卡按钮暴露原始 JSX 表达式文本（U.1 批量替换缺陷）→ 修复后重截 session.png；SettingsDialog 补 Esc 关闭。
- 待办：`baseline/` 侧 ZCode / Cortex 参考截图仍需人工提供（放入后跑 `node apps/desktop/scripts/compare-baseline.mjs` 出视觉评分），以及 `manifest.json` 登记来源。
