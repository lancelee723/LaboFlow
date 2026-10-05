# 专家工具白名单 + 团队验证门实施记录（2026-10-05，branch `expert-tools-verify`）

背景：与 `@fradser/pi-agent-teams` 对比调研后，用户批准吸收两点——(1) 逐专家工具白名单，(2) 验证门。
基线：`main` @ 22f0eda（独立 worktree 开发，未触碰主工作区）。

## 提交
| 提交 | 内容 | 侵入面 |
|---|---|---|
| `b1ff5847d` | 验证门：拆解提取 [验收] 标准 → 成员 brief；集成「验收核对」段（✓/✗+证据，未达成时下一步建议首条为补救）；Loop 第 2 轮起 DONE 前逐条自检 | 零侵入（仅 team-runner 模板） |
| `d5c7946e2` | 工具白名单存储/透传/编辑器：host-core tools 字段、service/registry/driver 链路、withToolsClause 人格声明、设置页多选（SUBAGENT_ASSIGNABLE_TOOLS 目录）、i18n ×9 | 我方文件 + host-core 我方模块 |
| `b02e2359c` | 硬过滤：sidecar/runtime 可选 allowedTools、rebuildToolCatalog 单点过滤（保留 asktool/new_context/ToolSearch按需/Skill有技能时）、matches 白名单退役、session-launch/agent-ipc 透传 | **Pi-Desktop 增量字段（本笔可单独 revert 退化为提示词级）** |

## 验证
- agent-runtime **1132/1132**（新增 4 例）
- desktop **3561 测试 / 3550 通过 / 7 失败**——7 例经 stash 基线对照确认全部为 `main@22f0eda` 既有失败（ppt-panel-bridge 6 例：HEAD 已删 lib/slides.js 而 main.js 仍引用；bundled-plugins skills contract 1 例为全量并发干扰，基线同样失败）；**本次改动零新增失败，净增 2 个通过用例**
- host-core **701/701**（含 tools 往返新断言）
- tsc --noEmit 无错；i18n 9 locale 构建通过

## 与 pi-agent-teams 的语义对齐
- 白名单默认不限制（与子代理默认只读不同）：专家面向咨询场景，默认全工具可用，白名单是收紧手段；保留集（ask/上下文压缩/发现/Skill）保证会话机制完整，ToolSearch 只能激活白名单内工具。
- 验证门沿用既有 loop 裁决协议，不引入独立 verify 角色（成本考量）；集成者承担验证者职责，标准在拆解时前置（Workbuddy 式 SOP 前置 + pi-agent-teams 式验收前置）。
