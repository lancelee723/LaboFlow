# P0–P3 执行与验证状态（2026-10-03/04 夜，ppt-l2 后续批次）

| 文档属性 | 内容 |
|---|---|
| 分支 | main @ 4e891e13d（基于用户 phase6 主线） |
| 范围 | DEVPLAN 遗留项 P0–P3 全量执行结果 + 实机验证状态如实登记 |
| 关联 | [PPT-MASTER-PLUGIN-DEVPLAN.md](PPT-MASTER-PLUGIN-DEVPLAN.md)、[REMAINDER-TASKS-2026-10-02.md](REMAINDER-TASKS-2026-10-02.md) |

## 已落地（全部有测试/证据）

| 项 | 提交 | 验证 |
|---|---|---|
| P1.3 re-vendor v6.6.0（92 commits 增益：字体宽度表/印度系排版/Morph/edit-native/--kiosk） | f71e67fa | argspec 10/10、bundled 42/42、PPT_IT 4/4（真机 venv）、S10 重放 13/13、requirements 零漂移 |
| P1.4 FR-PPT-16 成本预估+页数预算（5 种 Agent 形态识别、State 持久化、确认卡 8 语言、超限确认即放行、budgetPages 设置） | 559061b9 | ppt-budget 5/5 |
| P2.6 页级操作（delete/regenerate/rename，backup 语义+审计+final 报告失效）+ P2.8 轻量版（工作台大纲树+backup 历史分区） | 55ffc54f | panel-bridge 9/9（含穿越/冲突拒绝） |
| P2.7 FR-PPT-08 五主题 / FR-PPT-13 三画幅+原生图表开关 / FR-PPT-15 专家结构化技能绑定（invoke+TeamRunner 渲染进 personaPrompt） | 31d89a76 | 主题×5 导出+accent 断言、画幅几何断言、chart part 有无对照、绑定渲染测试；17/17 |
| P1.5 pyc 治理（preamble 强制 PYTHONDONTWRITEBYTECODE=1 + 体积守卫跳过 __pycache__） | 71cef0afc | git 内 0 pyc；真机 GUI 直调再生的 pyc 不再入库 |
| P3.10a 离线 wheelhouse（--no-index --find-links + offlineWheelhouse 设置 + 构建脚本） | 4b5f1950b | runtime 14/14 |
| P3.11 双轨边界文档（WebUI/插件分工/回流规则） | 8e58d873 | 文档 |
| 顺带修复：agent-host 缺 usage 分支（上游合并带入，dev 启动阻断）；9 处 %20 路径 bug；chat-shell/work-panel lint token 化 | 71cef0afc/4e891e13d | 全量 3534/0（复跑）；style tokens OK |

## 实机验证状态（如实）

- **已达成（真实环境）**：① main 分支应用真实启动，插件日志确认 `laboflow.slides` 加载且 **2 个技能注册**（薄壳+slides 进 Agent 目录）；② S10 协议级重放 13/13（真实 host-core+插件分发链+真实导出）；③ PPT_IT 真机 4/4（真实 venv + v6.6.0 上游脚本全链 + 30 页长任务 6.7s）。
- **受阻（环境限制，非产品缺陷）**：Computer-Use MCP 本会话不可用；CDP/AX 驱动在「后台 shell 启动的 Electron」上渲染层全部冻结（已用判别实验证明：**已知良好的 t64x 构建以相同配方同样冻结**，而用户 GUI 会话内启动的实例正常）——属启动上下文限制。
- **交接给用户的 5 分钟 GUI 验收单**（应用内）：① 新建会话发「用 SLIDES 插件把茂名脚本稿做成麦肯锡风格 PPT」→ 观察确认卡/工作台内嵌确认区出现且含**预算条**（FR-PPT-16）→ 确认后管线推进；② 工作台翻页预览处悬停页面条目出现 ↻/✕/✎ 页操作（FR-PPT-04）；③ settings → Slides → 五主题/画幅/budgetPages/offlineWheelhouse 可见（FR-PPT-08/13/16）；④ @PPT制作师 召唤后让 Expert 列出所用技能（绑定生效，FR-PPT-15）；⑤ re-vendor 后中文排版度量增益抽看任一新导出页字体对齐（v6.6.0）。

## 未做（本轮明确不做，均有依据）

- icons 子集化：49.4MB 图标库被上游 inventory 按需引用，盲裁会破坏引用——需先做使用数据分析，单独立项。
- 10-prompt 路由评分与双引擎盲评的**真人**环节：依赖用户真实模型会话（GUI 验收单第①步顺带覆盖路由证据）。
- 组织模板包真机端到端：需 server（真实 PG）与管理台双端联调，建议随 phase6 联调窗口执行。
