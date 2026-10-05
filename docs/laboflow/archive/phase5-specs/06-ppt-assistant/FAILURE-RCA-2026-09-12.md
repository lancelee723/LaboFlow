# 失败会话根因登记（R1–R4）——「脚本稿转麦肯锡风格PPT」

| 文档属性 | 内容 |
|---|---|
| 日期 | 2026-09-12 |
| 会话 | `~/.pi-desktop/sessions/3bd626ab-42fc-4c6a-ada4-657b18df2a18.jsonl`（2026-09-12 09:17–10:00，用户手动终止） |
| 性质 | DEVPLAN v1.1 M0.4 登记项；R1–R4 是 ppt-l2-rebuild 分支各阶段的验收锚点 |
| 详证 | [PPT-MASTER-PLUGIN-DEVPLAN.md](PPT-MASTER-PLUGIN-DEVPLAN.md) §1.3（时间线与取证） |

## 根因与销项映射

| # | 根因 | 证据要点 | 销项阶段 | 销项验收 |
|---|---|---|---|---|
| R1 | **触发断裂**：L2 存在但不可达——vendored SKILL.md 未列入 `contributes.skills`，L2 工具未注册，Agent ToolSearch 只搜到 L1 | 会话内 0 次提及 ppt_master；manifest 仅声明 slides 两工具 | **Phase A**（薄壳技能 + 4 工具注册） | S10 重放：路由命中 L2；ToolSearch 可发现 `ppt_master_status` |
| R2 | **确认失效**：「未确认不得导出」仅提示词级，被系统提示端到端倾向压过；全程未就大纲/设计征求确认 | Agent thinking 原话「用户的详细要求即预确认」；唯一交互是权限 asktool | **Phase A**（chat 确认话术，beta）→ **Phase B**（状态机 + 导出硬门禁） | A：Stage-1/2 在 chat 停下等待 ≥9/10 场景；B：无 result.json 时导出拒绝率 100% |
| R3 | **能力天花板**：L1 导出器忽略 data/matrix/columns/milestones 字段，迫使 Agent 手写 python-pptx 后处理 | 会话 09:23 解包探针结论「导出器只渲染标题/正文文本」 | **复核后销项**：当前代码 `lib/slides.js` 的 8 版式均已真实渲染（data 指标卡/matrix 四象限/compare·timeline 原生表格）——R3 系会话时点插件资源为旧版所致；已补 graphicFrame 断言固化（`slides-plugin.test.mjs`） | graphicFrame 原生表格断言通过（12 版式样张覆盖 8 版式） |
| R4 | **环境与权限摩擦**：venv 未装且无入口装/查；Agent Bash 直调 python 触发 6 次 TOOL_DENIED，耗时约 20 分钟 | 09:25–09:50 六次 `{"code":"TOOL_DENIED"}`；`~/.laboflow/ppt-runtime/` 不存在 | **Phase A**（status/setup/job 工具 + uv 自举 + preamble 权限模式指引）；B 的 ppt_script 白名单进一步收敛 | A：全新 venv setup → ready ≤5–8 分钟；S10 权限拒绝 ≤2 次 |

## 附带疑点（单列排查，不阻塞主线）

- **theme 参数被拒（已解除）**：09:48 `slides_export`（带 `theme`）被拒、09:50 去掉 theme 重试成功——取证显示被拒调用 `durationMs: 120024`，即 **ask 模式权限确认 120 秒超时自动拒绝**（Pi fail-closed 语义），与 theme 参数内容无关（当次确认弹窗无人响应；09:23 与 09:50 两次同参数调用均因人工点允许而成功）。缓解即薄壳技能 preamble 第 6 条：L2 会话建议 accept-edits/auto 模式，避免确认弹窗超时打断管线。
- **子代理幻觉**：用户 prompt 建议「派生子代理」，Pi 运行时 delegate 不可分配插件工具——薄壳技能已明示 L2 必须主会话执行（RP-5）。
