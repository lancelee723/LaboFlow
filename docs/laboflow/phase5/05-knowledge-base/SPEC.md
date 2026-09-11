# SPEC：接入知识库（模块 05）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[PLAN](PLAN.md) |
| 变更面 | host-core（`mcp_servers` 加 source/org_id 列 + kv 键 `kb.urls`，无新表）、electron/main（kb 视图服务 + 下发处理 + 浏览器面板扩展）、渲染层（设置 tab + 引用卡 + 侧栏入口）、apps/server + admin-console（下发配置） |

---

## 1. 架构总览

```
渲染层
 ├─ 设置 → 知识库 tab（检索服务登记/连接测试/指引；网页 URL 列表）
 ├─ 侧栏「知识库」入口 → KbBrowserPanel（WebContentsView, partition persist:kb-browser）
 └─ 会话流：引用卡（检索工具结果）+ [引用:n] 标注
        │ IPC（pi-desktop/kb/*）
主进程
 ├─ KbService            mcp_servers 的知识库视图（来源标记 org|user）+ kb.urls 管理 + 探活
 ├─ 复用 UserMcpRuntime  连接池与状态机（零复制——检索服务就是 MCP 服务器，只是带来源标记）
 ├─ OrgService 扩展      bootstrap kbServers[] 处理（MCP→mcp_servers(source=org) upsert + secrets；URL→kv）
 └─ BrowserView 扩展     第二实例（kb partition）+ 下载拦截 + 带入会话
        │
apps/server：org_kb_servers 表 + 管理台配置页 + bootstrap 载荷扩展
```

**核心架构决策**：

1. **开放标准优先**（ADR-KB1）：不写死 WeKnora——检索通道是通用 MCP 客户端（WeKnora 是一等公民引导，非硬依赖）；浏览通道是通用 URL。任何有 MCP 检索能力或网页端的知识库平台等价接入。
2. **复用 `mcp_servers` 唯一注册表**（ADR-KB2，裁决 R5-10）：知识库检索服务**就是** MCP 服务器——仅给既有 `mcp_servers` 表加 `source`（user|org）与 `org_id` 列，组织条目豁免个人 16 上限（上限按 source=user 计数）；**不建平行注册表**（避免第二真相源与双份连接代码）；运行时零改动复用 `UserMcpRuntime` 连接池与状态机。网页 URL 列表存 host kv（`kb.urls`），同样不建表。
3. **内嵌浏览 = 第二个 BrowserView 实例**（ADR-KB3）：复用 `browser-view.ts` 的 WebContentsView 管理，独立 partition `persist:kb-browser`（登录态/缓存与工作浏览器隔离）；仅浏览+下载，不接 CDP 操控（与 `pi.browser` 的工作浏览器能力区隔，降低安全面）。

## 2. 数据模型

### 2.1 host-core SQLite（迁移 v16：`mcp_servers` 加列 + kv 键；**无新表**）

```
mcp_servers 扩展列：
  source TEXT DEFAULT 'user'     -- 'user' | 'org'
  org_id TEXT NULL               -- source=org 时的下发组织
（16 上限校验改为 COUNT(source='user')；source=org 行客户端只读、登出停用不清除）

kv 新键：
  kb.urls → JSON [{id, name, url, source 'user'|'org', org_id?, sort_key}]   // 网页端入口列表
```

IPC `pi-desktop/kb/listServers|saveServer|deleteServer|testServer|toggleServer` 为 `mcp_servers`（知识库视图，含来源过滤与只读保护）的封装；`kb/listUrls|saveUrl|deleteUrl` 为 kv 封装。

### 2.2 服务端（Postgres）

```
org_kb_servers(id, org_id, kind 'mcp'|'web', name UNIQUE(org_id, name),
               transport, url, api_key_enc, description,
               scope 'all'|'teams', team_ids JSONB, enabled, created_by, created_at)
```

bootstrap 载荷扩展：`kbServers: [{kind:'mcp', name, transport, url, apiKey(信封), enabled} | {kind:'web', name, url}]`（按成员团队过滤 scope）。

## 3. 关键设计

### 3.1 检索工具的接入形态

- WeKnora 推荐配置（指引文案直接可抄）：
  - 远程（组织/服务器部署）：`transport=http`，`url=<weknora>/mcp`（或官方 MCP 网关地址），`headers: {"X-API-Key": "<scoped key>"}`；
  - 本地（个人）：`transport=stdio`，`command=uvx --from tencent-weknora-mcp weknora-mcp-server`，`env WEKNORA_API_KEY/WEKNORA_BASE_URL`。
- 探活：`listTools` 成功 → 状态 ok + 工具清单（供 UI 展示「该服务提供 N 个工具」）；失败分诊断（ENOTFOUND/ECONNREFUSED→网络；401/403→鉴权；协议错误→不兼容）。
- 工具命名沿用 `mcp__<server>__<tool>` 全局约定，权限审批走既有 MCP 类规则。

### 3.2 引用卡与引用契约

- 识别启发（双条件，未命中降级普通渲染）：
  1. 工具名匹配 `/(hybrid_)?search|retriev|query/`；或
  2. 返回结构含 `{results[]: {content|text, source|document|kb, score?}}` 形态。
- 引用卡数据：`{index, kbServer, docTitle, snippet(≤300 字), score?, url?}`；≤50 条虚拟滚动。
- 提示词契约：`composeSystemPrompt` 行为子句追加——「使用知识库检索工具后，事实性陈述需以 [引用:n] 标注对应来源；无引用支撑的推断需声明」。渲染层将 `[引用:n]` 解析为可点击角标（hover 显示引用卡摘要，点击滚动到卡）。
- 「打开来源」：url 存在 → KbBrowserPanel 新标签打开；无 url → 展示完整片段。

### 3.3 内嵌浏览器面板

- 实例：`browser-view.ts` 参数化出第二实例 `{partition:'persist:kb-browser', downloadPolicy:'ask'}`；bounds 由渲染层测量回传（既有机制）。
- 入口：侧栏快速操作「知识库」+ 工作区左栏（模块 02 空间列表底部「外部知识库」区）。
- 下载拦截：`session.on('will-download')` → 保存对话框（默认 OS 下载目录，记住上次）→ 完成后 toast 提供「带入会话」（`prompt-attachments` 既有附件链路）。
- 白名单：kb_urls 列表内的 origin 可自由导航；外部跳转（非列表 origin）询问「在系统浏览器打开」。
- 多标签：面板内 tab 条（≤8），持久化最近会话。

### 3.4 IPC 契约（`pi-desktop/kb/*`）

```
kb/listServers|saveServer|deleteServer|testServer|toggleServer
kb/listUrls|saveUrl|deleteUrl
kb/openPanel|panelAction（navigate/back/forward/refresh/newTab/closeTab）   // 复用 browser IPC 形态
kb/attachToSession（下载文件带入会话）
事件：pi-desktop/event/kbState（连接状态变化）
```

## 4. 安全设计

- Key 链路：管理台录入 → 服务端 `api_key_enc`（应用层加密，KMS/环境主键）→ bootstrap TLS → 客户端 host secrets（AES-256-GCM）；UI 仅显示尾 4 位；审计：下发/停用/成员接收事件。
- 隔离：kb partition 独立（cookies/缓存/下载）；不注入脚本到知识库页面（无 CDP attach）。
- 代理：kb 浏览器与 MCP 连接遵循既有 `network-proxy.ts` 全局设置（内网 WeKnora 场景）。
- 非环回 HTTP MCP：沿用 ADR-0142 的显式确认。

## 5. 测试策略

| 层 | 用例 |
|---|---|
| 单测 | mcp_servers 来源扩展语义（org 只读/上限豁免计数/kv kb.urls）；引用识别双启发（正样本/负样本）；引用角标解析；bootstrap kbServers 处理（upsert/停用/团队过滤） |
| 集成 | mock MCP 服务器探活三态分诊断；组织下发→成员生效→停用链路（真实 PG）；下载拦截→保存→带入会话 |
| 真机 | docker compose 部署真实 WeKnora：13 格式抽 3 类上传 → hybrid_search 检索 → 引用回答 → 网页端浏览/下载全链路；三平台浏览器面板回归 |
| 安全 | Key 抓包/落盘检查（全程密文）；partition 隔离（cookie 不串）；白名单外跳转拦截 |
