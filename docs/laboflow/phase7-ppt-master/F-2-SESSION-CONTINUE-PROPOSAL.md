# F-2 后续提案：插件触发的会话续跑（session continue-from-plugin）

- 状态：**已批准并实施（2026-10-28）**——宿主 `pi.session.continueFromPlugin`（权限 `session.continue`，高频风险档，滑动窗口节流）+ 插件 v4.1.0 confirmStage 触发。本文档保留为设计记录
- 背景：ACCEPTANCE.md 走查发现 F-2；2026-10-27 已落地过渡缓解（工具返回文案要求模型"保持回合存活并轮询"，实机生效：确认后模型轮询 21 次自主续进，零人工推动）
- 关联：ADR 0041（独立插件仓库）、phase7 DESIGN §5.1

## 问题

确认门的决策发生在工作台（用户点击），但会话的推进者只有 Agent。模型在门前的
回合顺从度不可靠：glm-5.3-flash 曾多次"宣布计划即结束回合"（F-2 原始观察）。
文案缓解依赖模型服从，不是结构保证。

## 现状约束（2026-10-27 调研结论）

插件可用的宿主 API 中不存在会话注入原语：

- `pi.session.*` 全只读（list/get/listMessages/import/rename/delete）；
- `pi.agent.complete` 是裸 LLM 补全调用，与 会话回合 无关；
- AgentExtensionBridge 的 prompt 通道是受信扩展的模态 UI 机制（confirm/select/input），
  需要贡献 sidecar 扩展模块，重量级且语义不符；
- 渲染层 composer 的 sendMessage IPC 只有宿主自己能调。

## 提案：`pi.session.continueFromPlugin`

```ts
session: {
  /** Ask the host to resume the session's agent turn with a plugin-authored
   *  continuation instruction. */
  continueFromPlugin: (input: {
    sessionId: string;
    text: string;            // instruction shown to the model as a user-role message
    /** Telemetry tag; the host logs plugin-originated continues distinctly. */
    reason?: string;
  }) => Promise<{ queued: boolean }>;
}
```

语义与边界：

1. **新权限 `session.continue`**（默认不授予；`laboflow.ppt-master` 的发行配置显式声明）。
2. 宿主侧节流：同一 (session, plugin) 每分钟最多 N 次（防插件风暴）；回合进行中时
   返回 `queued: false` 而非排队堆积。
3. 注入的消息在转录中标注来源（`origin: plugin:<id>`），对用户可见、对模型是
   user 角色——不冒充真实用户输入的静默通道。
4. 触发点（ppt-master 侧）：`ppt.confirmStage` 面板通道确认成功后，插件以
   reason: "stage-confirmed" 续跑；`ppt.setup` 作业完成同样适用。
5. 宿主实现：`plugin-runtime` hostApi → services → 复用渲染层既有的
   composer sendMessage IPC（与 onBrowserPreview → openWorkPanelTabForSession
   同层的 app-shell 事件亦可）。

## 备选与否决

- **长轮询在 ppt_stage_submit 工具内等待确认**：110s 工具预算杀死等待（既有结论）。
- **扩展模块模态机制**：语义是"向用户提问"，不是"替回合续跑"；架构重量不匹配。
- **仅保留文案缓解**：已生效但非结构性；模型换代/降级时回归。

## 待用户决策

批准后按 T4/T5 同型流程实施（SDK 类型 → services 钩子 → hostApi → 权限 →
ppt-master 触发点 + 测试），预计一个工作日内完成。
