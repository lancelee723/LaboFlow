# SPEC：多人多 Agent 协作（模块 02）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[PLAN](PLAN.md) |
| 变更面 | apps/server（spaces 模块 + WS 帧扩展 + y-websocket）、electron/main（空间客户端服务 + RevisionService + 剪藏）、渲染层（空间页/三种编辑器/composer 源扩展）、host-core（无变更——空间资产全在服务端） |

---

## 1. 架构总览

```
渲染层
 ├─ WorkspacesPage → 团队空间（左栏空间列表+文档树 / 右侧内容区）
 ├─ MdEditor（+评论侧栏+修订建议卡）   HtmlEditor（Yjs binding + presence）   CsvEditor
 ├─ Composer 文件选择器「团队空间」源
 └─ 产物卡「存入空间」
        │ IPC（pi-desktop/space/*）                │ WSS（JWT）
主进程                                          apps/server
 ├─ SpaceClient（REST + WS 复用 org 通道）       ├─ spaces 模块（节点/权限/邀请/审计）
 ├─ RevisionService（AI 修订建议管线）           ├─ space WS hub（doc/comment/revision/presence 帧）
 └─ ClipService（Readability 剪藏）              └─ y-websocket provider（HTML CRDT）
```

**核心架构决策**：

1. **空间资产全部服务端权威**（ADR-TC1）：文档树/正文/评论/建议存 Postgres，客户端仅缓存与 CRDT 本地副本（HTML）。与共享会话（`shared_sessions`）并行而不混用——会话是过程，文档是资产。
2. **MD 与 HTML 采用不同协同模型**（裁决 R5-7）：MD = 服务端权威 + 版本化提交 + 评论/修订建议（串行安全，契合「建议-审阅」体验）；HTML = Yjs CRDT（无锁合并 + awareness）。
3. **Agent 权限继承用户身份**（ADR-TC2）：桌面 Agent 访问空间一律经 `SpaceClient` 以当前登录用户 JWT 调服务端；服务端权限矩阵是唯一裁判。客户端不做任何本地权限复制判断（避免两套真相）。
4. **修订建议制由数据模型保证**：AI 产出/人工接受都落 `revision_suggestions` 表，可审计可追溯；「AI 修改必须可审阅」由数据模型保证而非 UI 约定。
5. **不自研协同与组件体系**（ADR-TC5，R5-10）：HTML 协同采用 CRDT 事实标准 **Yjs**（官方 `@y/websocket` provider + ProseMirror/TipTap binding，不自研 OT/合并算法）；前端编辑器组件遵循仓库既有体系（Tailwind 4 + `src/styles` ui-kit + `components/ui.tsx` 原语，不引入组件库、不自建设计系统）；客户端-服务端通信全部走既有模式（`org-workspaces.ts` 的 REST+WS 客户端先例、`pi-desktop/space/*` IPC 命名空间惯例）。

## 2. 服务端数据模型（Postgres，drizzle 迁移）

```
spaces(id, team_id, name, description, archived_at, created_by, created_at)
  └─ 沿用既有 workspaces 通道与成员表？否——独立 spaces 表（workspaces 面向共享会话），
     但 members/鉴权中间件复用既有 viewer/contributor/manager 矩阵实现。

space_members(space_id, user_id, perm 'viewer'|'contributor'|'manager', invited_by, created_at)
space_node_overrides(node_id, user_id/team_id, perm 含 'none'（显式无权限档）, ...)  -- 节点级覆盖

space_nodes(id, space_id, parent_id NULL, type 'folder'|'md'|'csv'|'html'|'file',
            name, sort_key, deleted_at NULL, deleted_by,    -- 回收站=软删
            created_by, updated_by, updated_at)

space_docs(node_id PK/FK, current_version, updated_at)
space_doc_versions(node_id, version, content TEXT/BYTEA, sha256, author_id, source 'human'|'ai-accept'|'agent-direct',
                   created_at, UNIQUE(node_id, version))     -- MD/CSV 正文版本链（20 版滚动可配）

space_files(node_id, storage_key, size, mime, sha256)         -- file 型节点 → 交付物卷存储复用

comments(id, node_id, anchor JSONB, author_id, body, parent_id NULL,
         status 'open'|'resolved', created_at, updated_at)
comment_reads(node_id, user_id, last_read_comment_id)          -- 未读徽标

revision_suggestions(id, node_id, anchor JSONB, original_text, revised_text, rationale,
                     status 'pending'|'accepted'|'rejected', requested_by, produced_by 'user'|'agent',
                     model, accepted_by, created_at, decided_at)

space_events(space_id, seq BIGSERIAL, type, payload JSONB, actor_id, created_at)  -- 推流与活动流共用
invite_links(id, space_id, token_hash, perm, access 'apply'|'view', expires_at, max_uses, uses, created_by)
org_settings(org_id, collab_scope 'internal'|'external')      -- 协作范围管控
audit_log 既有表扩展 target_type='space_node'/'space_member'/'revision'
```

**锚定（anchor）模型**（评论与修订共用）：

```json
{ "kind": "text", "paraIndex": 12, "textPrefix": "市场规模测算……", "textHash": "sha256(选区文本)" }
```

解析规则：定位 `paraIndex` 段落 → 在段落内匹配 `textHash`（原文精确）或 `textPrefix` 前缀（容错）；均失败=锚定失效（UI 显示「位置已变化」，内容保留）。HTML 节点锚定用 Yjs 相对路径（block id），CSV 用 `(row, col)`。

## 3. 关键设计

### 3.1 权限矩阵（服务端唯一裁判）

| 动作 | viewer | contributor | manager | none |
|---|---|---|---|---|
| 浏览树/读文档/读评论 | ✓ | ✓ | ✓ | ✗（404 同名伪装） |
| 评论/回复 | ✓（S 级可裁） | ✓ | ✓ | ✗ |
| 新建/编辑/上传/移动/删除节点 | ✗ | ✓（他人节点仅 manager 可删） | ✓ | ✗ |
| 接受/拒绝修订建议 | ✗ | ✓（仅自己请求的可撤回） | ✓ | ✗ |
| 邀请/改档/移除/链接管理 | ✗ | ✗ | ✓ | ✗ |
| Agent 代读/代写 | 按**发起用户**档位执行，同矩阵 | | | |

Agent 代写 MD 一律落 `revision_suggestions(produ_by='agent')`；组织策略 `space.agent_direct_write=true` 时才允许直接提交版本（source='agent-direct'，审计强制）。

### 3.2 WS 推流帧（扩展既有 hub 模式）

```json
{"type":"node.updated","payload":{"nodeId","updatedAt","updatedBy"}}
{"type":"doc.version","payload":{"nodeId","version"}}            // MD/CSV 通告，客户端拉取
{"type":"comment.created|replied|status","payload":{...}}
{"type":"revision.created|decided","payload":{"nodeId","suggestionId","status"}}
{"type":"presence.update","payload":{"nodeId","userId","cursor"}}  // awareness 快播
```

Yjs 二进制 update 走独立 `/yjs/:docId` 连接（不改 JSON 帧协议）。断线重连：`space_events.seq` 增量拉取（沿用共享会话 since 语义）。

### 3.3 RevisionService（主进程，AI 修订管线）

```
suggest(nodeId, selection, instruction, byUser|agentSession):
 1. 拉文档（当前版本）+ 选区上下文（前后各 1 段）
 2. one-shot LLM：产出 {revisedText, rationale}（结构化输出，失败重试 1 次）
 3. POST /spaces/:id/nodes/:nid/revisions（服务端存 pending，广播 revision.created）
 4. UI 侧栏对照卡：原文（锚定高亮）/改后/理由/接受/拒绝

apply(revisionIds[]):  服务端事务：按锚定排序串行合并 →
  任一锚定失效/重叠 → 该条标记 conflict，其余继续；全部成功 → 提交新 doc version（source='ai-accept'）
  → 广播 doc.version + revision.decided
按评论修订（reviewByComments）：聚合 node 全部 open 评论 → 多锚定 suggest → 批量 pending → 通知评论者

撤销栈：客户端编辑器维护（AI 接受/手动编辑统一栈）；服务端版本链兜底回滚。
```

### 3.4 HTML CRDT（Yjs）

- 服务端：官方 **`@y/websocket`** provider（连接鉴权 + update 广播 + 文档快照持久化到 `space_docs` 二进制列，快照间隔 30s 或 500 update）；不自研 provider。
- 客户端：`HtmlEditor` 基于 Yjs + 块结构（Y.XmlFragment）；presence = Y.PeerAwareness（光标/选区/显示名/指定色）。
- AI 划词直改：本地事务内应用（Y.UndoManager 捕获 → 撤销栈统一），改动块临时高亮（CSS class + 10s 衰减）。
- **降级预案**（T52.13 做不通时）：段落级锁（复用回合锁 90s 心跳语义）+ 最后写入胜出，接口不变仅换 provider 内部实现。

### 3.5 IPC 契约（`pi-desktop/space/*`）

```
list/spaces, tree/list, node/create|rename|move|delete|restore, doc/get|save,
upload/start|chunk|finish, clip/save, comments/list|create|reply|resolve,
revisions/list|suggest|decide|decideBatch|reviewByComments,
events/pull(since), search
事件：pi-desktop/event/spaceFrame（WS 帧转发，复用 orgWsFrame 模式）
```

### 3.6 剪藏与 Agent 直落

- 剪藏：browser-view 加载 URL（同 session 复用）→ 注入 Readability 提取（正文 HTML + 标题 + 站点）→ 转 MD（表格/图片链接保留）→ `clip/save`（附 `{sourceUrl, clippedAt}` 元数据）。
- Agent 直落：会话产物卡「存入空间」（选路径 → upload）；指令级重定向（「生成到空间 X」）由 Agent 调 `space.upload` agentTool（权限=发起用户，写 MD 默认转修订建议）。

## 4. 安全设计

- 链接邀请：token 哈希存储、有效期与次数上限、仅组织内模式校验账号 org_id。
- 上传：MIME 白名单 + 大小限制 + 病毒扫描钩子（预留，默认关）；存储键不可枚举。
- Agent 代读审计：`audit_log` 记录 agent 会话 id 与发起用户 id 双标识。
- 权限错误语义：none 档返回 404（不泄露存在性）；其余 403 带可读原因（PRD FR-TC-07）。

## 5. 测试策略

| 层 | 用例 |
|---|---|
| 服务端单测 | 权限矩阵纯函数（节点覆盖/none 档/agent 代读代写）、锚定解析（精确/前缀/失效）、修订合并（串行/冲突标记） |
| 服务端集成 | 树操作/邀请流/事件推流断线重连/审计完整性（真实 PG + WS） |
| 客户端单测 | MD 往返快照、CSV 往返不变性、撤销栈混合回退、锚定失效降级 |
| 收敛性自动化 | Yjs 随机操作流（10 客户端 ×10k 步）最终状态一致 |
| E2E | 三人协作剧本：A 建空间邀 B/C → B 上传+写 MD → C 划词评论 → A 按评论修订 → B 接受 → 三人 HTML 同时编辑 |
| 渗透 | 越权矩阵（人/Agent 双身份 × 四档 × 主要动作）全量拒绝 |
