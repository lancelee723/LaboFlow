# SPEC：接入 IM 工具（模块 04）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[PLAN](PLAN.md) |
| 变更面 | electron/main（channels/ 模块群）、shared（IPC 命名空间）、渲染层（设置助理 tab）、apps/server + admin-console（bots 中继） |

---

## 1. 架构总览

```
飞书开放平台 ──WSS──┐                        ┌── 微信公众号服务器
                    │                        │     ↑（HTTPS 回调）
企微开放平台 ──WSS──┼─ ChannelAdapter 群     │ apps/server bots 中继
                    │  （electron/main/      │  ├─ POST /bots/webhook/wechat（验签/解密）
通用 Webhook ──HTTP─┘   channels/）          │  ├─ bot 绑定注册 + 离线暂存 ≤24h
        │                │                   │  └─ 出站：客服消息 API / 素材上传
        ▼                ▼                   ▼
   InboundMessage{channelId, senderRef, chatRef, text, files, raw}
        └──────────────► AssistantDispatcher（模块 03）
                          │ 回推 OutboundPayload{reply, files, statusCard}
                          ▼
   ChannelAdapter.send/sendFile（各平台 API/SDK）
```

**核心架构决策**：

1. **通道适配层在客户端主进程，长连接直连**（ADR-IM1）：飞书/企微走官方 WSS（免公网、凭证不出本机）；仅公众号（回调必须公网）经服务端中继。通道不进渲染进程（凭证与协议隔离）。
2. **消息规范化解耦**（ADR-IM2）：所有通道收敛到 `InboundMessage`/`OutboundPayload` 两个结构，AssistantDispatcher 与审批回路不感知平台；平台差异（分片/窗口/文件限额）收敛在各适配器的 `capabilities` 声明里。
3. **中继无状态、绑定持久**（ADR-IM3）：服务端只存 bot 凭证与绑定关系（哪台客户端服务哪个 bot），消息不落正文（暂存仅元数据+密文体，≤24h，重投即删）；横向扩容按 bot 分片。

## 2. 模块与数据模型

### 2.1 客户端（electron/main/channels/）

```
channels/
 ├─ types.ts          ChannelAdapter 接口 + Capabilities{maxTextBytes, fileMaxBytes,
 │                    replyWindowMs?, streaming, card} + InboundMessage/OutboundPayload
 ├─ registry.ts       注册表/生命周期/状态机（disconnected→connecting→connected→error）
 ├─ credential-store.ts   host secrets 封装（空值=未修改；连接预检通过才替换）
 ├─ feishu/           SDK WS 客户端 + 消息收发 + 错误码映射表
 ├─ wecom/            WSS 客户端（官方 SDK 优先）+ 流式回复 + 分片上传
 └─ wechat-mp/        bot.inbound 帧消费 + 服务端出站调用
```

host-core 新表 `channel_accounts`（迁移 v15）：`(id, provider 'feishu'|'wecom'|'wechat_mp', name, secret_ref（host secrets 键）, scope 'p2p'|'group'|'both', allowlist JSON, enabled, last_connected_at, created_at)`——凭证本体在 secrets，表存引用与配置。

### 2.2 服务端（apps/server bots 模块）

```
bots(id, org_id, provider, name, creds_enc, allow_user_ids JSON, allow_team_ids JSON,
     created_by, created_at)
bot_bindings(bot_id, user_id, device_id NULL, ws_conn_id NULL, last_seen_at)   -- 在线路由
bot_pending(bot_id, payload_enc, retries, created_at, deliver_after)          -- 离线暂存 ≤24h
```

API：`POST/GET/DELETE /org/bots`（sys_admin）、内部帧：WS `bot.inbound {botId, message}` / `bot.outbound {botId, reply}`（复用 org WS 连接与 JWT 鉴权，新增帧类型经既有 hub）。

## 3. 关键设计

### 3.1 ChannelAdapter 接口

```ts
interface ChannelAdapter {
  provider: string;
  capabilities: Capabilities;
  connect(account: ChannelAccount): Promise<void>;     // 建立长连接/注册帧消费
  disconnect(): Promise<void>;
  send(ref: ChatRef, payload: OutboundPayload): Promise<SendResult>;
  onMessage(cb: (m: InboundMessage) => void): void;    // 规范化后回调（去重后）
  onState(cb: (s: ChannelState, diag?: DiagInfo) => void): void;
}
// OutboundPayload{replyText, files[], statusCard?, streamChunks?}
// DiagInfo{kind:'network'|'credential'|'permission'|'publish'|'unknown', detailZh, rawCode}
```

白名单过滤在 registry 层统一做（进入 Dispatcher 之前），默认仅配置者本人（按平台身份标识：飞书 open_id / 企微 userid / 公众号 openid 绑定组织账号）。

### 3.2 飞书适配器要点

- SDK：`@larksuiteoapi/lark-oapi`（WS 客户端）；凭证 app_id/app_secret。
- 收：`im.message.receive_v1` → 解 `content`（JSON 字符串二次解析，蓝本=冻结仓库飞书信封经验）→ `InboundMessage`；群聊仅 @bot 消息（mentions 剥离后正文）；`message_id` LRU 去重（平台重推 + 3s 超时重推 4 次）。
- ACK：SDK 回调即返（处理异步化），满足 3s 限制。
- 发：`POST /open-apis/im/v1/messages?receive_id_type=open_id`（text/post/interactive）；回复优先 `{message_id}/reply` + `uuid` 幂等；卡片用于状态（标题/状态/耗时/token/展开全文）。
- 文件：图片 `im/v1/images`（≤10MB）→ image_key；文件 `im/v1/files`（≤30MB）→ file_key。
- 限速：5 QPS/用户、5 QPS/群、应用 50 QPS——令牌桶节流，超限排队。
- 诊断映射：`10014` 凭证无效；`99991672`/权限类 → 列缺失 scope；应用未发布/可用范围 → publish 类提示。

### 3.3 企微智能机器人适配器要点

- 连接：`wss://openws.work.weixin.qq.com`，BotID+Secret（SDK `@wecom/aibot-node-sdk` 优先；不可用则按官方协议自实现：鉴权帧/30s ping/单连接互踢处理）。
- 收：文本/引用（单聊 + 群@机器人）；语音到达为转写文本（直接当文本处理）。
- 发：`markdown` ≤20480B 分片；`template_card` 状态卡；流式 `stream` 分块（finish ≤10min）。
- 文件：`aibot_upload_media_init/chunk/finish` 分片（图/视频 ≤10MB、语音 ≤2MB、文件 ≤20MB；media_id 3 天有效——发送即时使用不受影响）。
- 窗口：24h 回复窗口内自由回复；会话级 30 条/分钟限速节流。

### 3.4 公众号中继链路

```
微信 → POST /bots/webhook/wechat（URL 验签 GET echostr；消息 AES 解密）
     → 查 bot 绑定 → 客户端在线：WS 帧 bot.inbound / 离线：bot_pending 暂存
     → 客户端 Dispatcher 执行 → bot.outbound 帧 → 服务端出站
     → 客服消息 API（access_token 缓存 7200s；48h/5 条窗口；超窗丢弃+日志）
     → 被动回复：5s 内先回「任务已开始，完成后推送给您」
文件：客户端上传产物至服务端临时存储（既有交付物卷临时区，24h 过期）→ 客服图文/链接消息。
```

### 3.5 IPC 契约（`pi-desktop/channels/*`）

```
channels/list|save|delete|connect|disconnect|test（连接体检，返回分诊断 DiagInfo）
channels/updateScope|updateAllowlist
事件：pi-desktop/event/channelState（状态灯）、pi-desktop/event/channelMessage（可选：通道原始消息进助理历史标注）
设置 tab「助理」：im-server 配置（模块 03）与通道卡同页展示。
```

## 4. 安全设计

- 凭证：全部 host secrets（AES-256-GCM）；表仅存引用；UI 永不回显明文；「预检通过才替换」防顶掉可用凭证。
- 白名单：默认仅本人可下指令；白名单外静默忽略（可配礼貌回应，频率受限 ≤1 条/会话/分钟）。
- 中继：回调验签（微信 signature + AES）；bot_pending 密文暂存；出站走服务端凭证（客户端不持有公众号 secret 之外的平台密钥——组织模式下公众号凭证仅在服务端）。
- 日志：消息正文脱敏（哈希+长度）；WS 帧不含凭证明文。

## 5. 测试策略

| 层 | 用例 |
|---|---|
| 单测 | registry 状态机/白名单/空值凭证保护；飞书 content 二次解析与去重 LRU；企微 markdown 分片与流式分块；公众号 48h/5 条窗口状态机；粘贴识别器（三平台凭证页样本语料） |
| 集成 | mock 平台服务器（WSS/HTTP 假端点）全链路：收→Dispatcher 桩→回；断线重连；暂存重投；限速节流 |
| 真机 | 飞书（私聊/群@/文件 30MB/断网恢复）；企微（流式/分片上传）；公众号（开发者工具回调模拟 + 测试号穿透）；48h soak（内存/连接数） |
| 联测 | 与模块 03：助理历史统一渲染、审批卡经 IM 回复「批准/拒绝」、桌面离线提示 |
