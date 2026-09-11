# PLAN：接入 IM 工具（模块 04）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[SPEC](SPEC.md)、[Phase5 总览](../README.md) |
| 依赖 | 模块 03 的 AssistantDispatcher 与 HeadlessAgentDriver（T53.1）；无则先以测试桩对接 |
| 工期估算 | 约 6 周（2 名工程师）；飞书（2 周）→ 企微（1.5 周）→ 中继+公众号（2 周）→ 收尾（0.5 周） |

> 任务格式：**T54.x 任务名**（S/M/L/XL）— 验收标准。通道顺序依据工程风险（飞书官方 WS 最顺 → 企微 WSS → 公众号需中继）。

---

## 批次 A：框架与飞书（M-IM1）

- **T54.1 ChannelAdapter 框架**（M）：`electron/main/channels/` 模块：`ChannelAdapter` 接口（connect/disconnect/send(channelRef, text)/sendFile(channelRef, path)/status 事件）、`ChannelRegistry`（注册/生命周期/状态聚合，供模块 03 总控台与设置页消费）、凭据存取封装（host secrets，空值不冲掉语义）、消息规范化 `InboundMessage{channelId, senderRef, chatRef, text, files?, raw}` → AssistantDispatcher 对接（或桩）。— 验收：框架单测（注册/状态机/凭据空值保护）；mock 适配器全链路（收→派→回）。
- **T54.2 设置「助理」tab 与通道卡组件**（M）：设置页新 tab（`SettingsPage.tsx` 导航 + 渲染分支）；通用通道卡（状态灯/表单/连接按钮/错误分诊断区/说明链接）；「粘贴一段自动识别」多行解析器（三平台凭证页文本 → 字段抽取，正则+关键字双策略）。— 验收：FR-IM-01/02；空值保存不冲掉（单测+手测）；i18n 键齐。
- **T54.3 飞书适配器**（L）：`channels/feishu/`：官方 Node SDK（`@larksuiteoapi/lark-oapi`）WS 长连接客户端；`im.message.receive_v1` 订阅（私聊 + 群@，mentions 剥离）；tenant_access_token 缓存（2h）；`im/v1/messages` 发送（text/post/interactive）与 `{message_id}/reply`；图片/文件上传（image_key/file_key）；message_id 去重窗口；3s ACK（入队即返）；断线指数退避重连；错误码映射表（10014 凭证无效/99991672 权限缺失/应用未发布等 → 分诊断文案）。— 验收：FR-IM-05~07；真机：私聊+群@下任务、文件回传 ≤30MB、断网 30s 恢复重连消息不丢；限速自我节流单测。
- **T54.4 飞书配置向导与权限指引**（S）：卡片内分步指引（开放平台建应用 → 开权限（`im:message*` 清单）→ 发布 → 粘凭证）；权限缺失时的逐项提示。— 验收：新用户按指引 15 分钟内从零连通过。

**Gate M-IM1**：飞书真机回归（PRD §5 M-IM1 项）；框架与设置页验收；既有 E2E 不回归。

## 批次 B：企业微信（M-IM2）

- **T54.5 企微智能机器人适配器**（L）：`channels/wecom/`：WSS 连接 `wss://openws.work.weixin.qq.com`（BotID+Secret 鉴权，官方 SDK `@wecom/aibot-node-sdk` 优先，协议自实现兜底）；收文本/引用（单聊+群@）；回复 markdown（≤20480B 分片）+ template_card；流式回复（stream 分块 + finish，10min 上限）；文件分片上传（init/chunk/finish，≤20MB）；30s ping 心跳与单连接互踢处理；错误码映射。— 验收：FR-IM-08/09；真机流式回复逐块刷出；群@与白名单过滤正确。
- **T54.6 企微配置向导**（S）：管理后台建智能机器人（API 模式）指引 + BotID/Secret 录入。— 验收：新用户 15 分钟连通过。

**Gate M-IM2**：企微真机回归；两通道并存（飞书+企微同时在线）稳定性 48h soak。

## 批次 C：服务端中继与公众号（M-IM3）

- **T54.7 服务端 bots 中继模块**（M）：`apps/server` 新 bots 模块（蓝本=冻结仓库 BotBridge 信封/签名设计 + 服务端化）：`POST /bots/webhook/wechat`（URL 验签 GET + 消息解密 POST，EncodingAESKey AES）；bot 注册/绑定 API（管理台：建 bot 凭证 ↔ 授权用户/团队）；客户端 WS 下发通道（复用既有 org WS 连接，新帧 `bot.inbound`）；客户端离线暂存 ≤24h 重投；出站：接收客户端回推 → 客服消息 API（access_token 缓存）。— 验收：微信开发者工具回调模拟全链路（验签/解密/路由/暂存重投）；集成测试（真实 HTTP + WS）。
- **T54.8 公众号适配器（客户端侧）**（M）：`channels/wechat-mp/`：消费 `bot.inbound` 帧 → AssistantDispatcher；回复经服务端出站 API；48h/5 条窗口管理与超窗日志；文本 ≤2048B 分片；文件→服务端临时存储（24h 链接）→图文卡；被动回复 5s 语义（先回「已开始」）。— 验收：FR-IM-11/12；测试号端到端（本机穿透环境）。
- **T54.9 管理台通道配置页**（S）：admin-console 新「IM 通道」区：公众号凭证录入/绑定成员/状态查看。— 验收：FR-IM-03（组织侧）；RBAC（sys_admin）。
- **T54.10 收尾**（S）：白名单与「无权限」回应（FR-IM-15）；错误码映射三通道全覆盖复查；30 天 soak 计划与监控上报。— 验收：Gate IM 清单。

**Gate IM（模块出口）**：见 PRD §5；含三通道真机回归 + 与模块 03 联测（助理历史统一、审批回路经 IM 回复批准/拒绝）。

## 里程碑总览

```
M-IM1（约 2 周）→ 框架 + 飞书 WS 通道（真机可用）
M-IM2（约 1.5 周）→ 企微智能机器人通道（流式）
M-IM3（约 2.5 周）→ 服务端中继 + 公众号通道 + 管理台 → Gate IM
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| 平台 SDK 质量/协议变更（企微智能机器人较新） | 官方 SDK 优先 + 协议自实现兜底（接口不变）；适配器单文件隔离，pin 版本 |
| 公众号中继的公网依赖让个人用户体验打折 | 产品话术明确「组织能力」；测试号+穿透指引；通用 Webhook/快捷指令兜底个人场景 |
| 凭证误冲掉/错存（Workbuddy 踩过的坑：显示已保存实则顶掉可用 Secret） | 空值=未修改语义前置单测；连接成功前不落库新凭证（预检通过才替换） |
| 离线暂存重投造成消息风暴 | 暂存上限/合并策略（同源同文本去重）；重投节流 |
