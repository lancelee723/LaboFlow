# PLAN：组织配置持续同步与按人授权（模块 03）

| 文档属性 | 内容 |
|---|---|
| 版本 | v0.1（草案） |
| 日期 | 2026-10-30 |
| 关联 | [PRD](PRD.md)、[组织集成计划](../02-org-integration-plan.md)、phase5 模块 01/05 |
| 硬依赖 | 无（bootstrap / 网关 / 管理台 / org 会话簿均在主干） |
| 工期估算 | 约 2 周（1 人串行）：服务端 5 天 + 桌面客户端 4 天 + 管理台 2 天 + 验收 2 天 |

> 任务格式：**T-OC.x 任务名**（S/M/L）— 验收标准。对位调研依据：Octop-Enterprise
> `src/octop/api/routers/client_config.py`、`src/octop/infra/users/employee_resources.py`（2026-10-30 勘察）。

---

## 批次 A：服务端（config-status / publish / 有效集 / 网关强制）

- **T-OC.1 迁移 v11**（M）：`apps/server/src/db/migrate.ts` 追加 version 11：
  - `org_config_releases(id uuid PK, message text, published_by uuid, published_at timestamptz)`
  - `user_resource_grants(id uuid PK, user_id uuid, kind text, resource_id text, effect text, updated_by uuid, updated_at timestamptz, UNIQUE(user_id, kind, resource_id))`
  - `org_config_applied(user_id uuid PK, revision text, applied_at timestamptz)`
  - schema.ts 同步导出类型。— 验收：迁移幂等重跑；空库/存量库升级路径测试。
- **T-OC.2 有效集纯函数**（M，核心）：新 `apps/server/src/org/effective-resources.ts`：
  输入（channels / packs / kb / templates / 用户 teamId / grants 行集），输出四类资源的有效集与
  `revision = sha256(稳定序列化)`。纯函数、无 I/O。— 验收：矩阵单测——默认/授予/收回 × 四类 kind；
  「无关变更不改变 revision」（他人资源、无关字段）；「任何影响该用户的变更必改变 revision」；
  **grants 空表时有效集与现状 bootstrap 输出逐字节一致**（差分断言，兼容红线）。
- **T-OC.3 status / publish / apply 端点**（M）：app.controller 新增
  `GET /org/config-status`（no-store、仅本人、组合 T-OC.2 + 最新 release → `{revision, message, publishedAt, pending}`）、
  `POST /org/config-publish`（sys_admin、message ≤500、审计 `config.publish`）、
  `POST /org/config-apply`（回写 org_config_applied）。— 验收：集成测试（真实 PG）——发布后 revision 变化、
  pending 翻转、非管理员 403、message 超长 422。
- **T-OC.4 bootstrap 过滤接入**（M）：`/org/bootstrap` 改走 T-OC.2 有效集过滤
  `orgChannels`；`expertPacks.deliveryFor()` 增 `userId` 参数（`deliveryFor(userId, teamId)`）；
  kb `deliveryFor(teamId)` 增按人覆盖；`slideTemplates` 查询接入。— 验收：差分测试
  （空 grants = 现状输出）；带 grants 时的过滤矩阵；既有 expert-packs / kb / admin 集成测试全绿。
- **T-OC.5 网关模型强制**（M）：`gateway.service.ts` `authenticate` 之后按有效渠道集校验
  请求模型，未授权抛 `403 EMODELNOTALLOWED`（含模型名，可读）；`route` 沿用有效集。
  — 验收：集成测试——授权模型 200、未授权 403、admin 全通、撤销后新请求立即 403。
- **T-OC.6（S，可后置）`GET /ws/org` 推送**：复用已注册的 `@fastify/websocket`，JWT 鉴权；
  publish / 授权变更后广播 `{type:"org.config.changed"}` 空载荷。— 验收：两客户端连接，
  发布后均收到事件、载荷不含他人信息；断线重连不重放（事件即弃，靠 status 比对）。

**Gate M-OC1**：T-OC.1~5（T-OC.6 可后置）；revision 矩阵 + 兼容差分 + 网关越权用例全绿。

## 批次 B：桌面客户端（同步回路 / 分层应用）

- **T-OC.7 config-status 客户端**（M）：`org-service.ts` 增 `fetchConfigStatus()`（经既有
  `spaceOrgRequest` 同款 org API 通道）；触发器：登录/状态刷新后、组织 WS 重连回调、
  主窗口 `focus`、60s ±20% 轮询（间隔常量可配）；revision 存入 org 会话簿（多账号各自记账）。
  — 验收：单测——状态机（初拉/无变化/有变化/稍后记账/应用后清账）；旧服务端 404 静默降级。
- **T-OC.8 更新提示与分层应用**（L，核心）：变化时 toast/横幅（message + 发布时间 +
  「立即更新 / 稍后」）；「稍后」同 revision 不再弹；「立即更新」= 幂等重放既有 bootstrap 消费链
  （`expertService.setOrgPacks` / 模板 / `kbServers → mcp.upsert source=org` / 渠道与虚拟 Key），
  UI 级立即生效，运行时级经**回合边界守卫**（进行中回合 → 提示完成后应用，保持 pending）；
  应用完成调 `config-apply`。— 验收：单测——幂等重放（两次应用结果一致）、回合中延迟应用、
  稍后去重；集成冒烟——撤销 KB 后工具面在下一回合消失。
- **T-OC.9 shared 类型与 i18n**（S）：`packages/shared` 补 `OrgBootstrap.expertPacks /
  kbServers / slideTemplates` 正式字段（现为 services.ts 内联结构）+ `OrgConfigStatus` 类型；
  新 UI 文案进九语言（en 为源）。— 验收：typecheck 0 错误；九语言键齐备断言。

**Gate M-OC2**：批次 A+B 全量；E2E「管理员发布 → 在线客户端提示 → 应用 → pending 清零」与
「撤销 → 下一回合生效」两条剧本。

## 批次 C：管理台

- **T-OC.10 用户资源授权编辑器**（M）：`pages/Users.tsx` 行内「资源授权」入口 → 编辑面板：
  渠道 / 专家包 / KB / 模板四组，每项显示有效来源徽章（团队默认/单独授予/单独收回），
  保存 = 该 kind 整体替换 + `expectedRevision`（409 冲突重读提示）。— 验收：组件测试——
  替换语义、冲突重试、只读用户不可编辑。
- **T-OC.11 系统设置发布区**（S）：`pages/Settings.tsx` 静态页增「配置更新发布」卡片：
  message 输入（≤500 计数）、发布按钮、最近 5 条发布记录。— 验收：组件测试 + 发布后
  config-status message 断言。

## 测试策略

| 层 | 用例 |
|---|---|
| 服务端单测 | 有效集矩阵（T-OC.2）、revision 稳定性/敏感性、兼容差分 |
| 服务端集成 | status/publish/apply（真实 PG）、bootstrap 过滤、网关 403、审计完整性 |
| 客户端单测 | 同步状态机、幂等重放、回合边界守卫、稍后去重、404 降级 |
| 管理台组件 | 授权编辑器替换语义/乐观锁、发布表单 |
| E2E | 发布→提示→应用→pending 清零；撤销→下一回合生效；离线重连补提示 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| bootstrap 过滤路径改坏既有下发（expertPacks 全量→过滤） | T-OC.4 强制「空 grants 差分断言」先行；Gate 回归 expert/kb/admin 切片 |
| 轮询惊群 / 服务端开销 | ±20% 抖动 + 间隔可配 + status 轻量（可加 per-user 60s 缓存）；WS 推送落地后可拉长轮询 |
| 客户端缓存与服务端有效集短暂不一致 | 服务端强制为唯一真相（网关/路由逐请求裁决），客户端缓存只影响可见性；pending 语义显式暴露 |
| team_admin 越权授权 | v1 收敛 sys_admin-only（PRD NFR-OC3）；放开前必须先做团队边界测试 |
| 多账号会话簿的 revision 串号 | revision 按 orgSessionKey 分账（沿用 multi-org book 既有键控） |

## 交付顺序与回归

```
T-OC.1 → T-OC.2 → (T-OC.3 ∥ T-OC.4) → T-OC.5 → [Gate M-OC1]
→ T-OC.7 → T-OC.8 → T-OC.9 → T-OC.10 → T-OC.11 → [Gate M-OC2 / Gate OC]
（T-OC.6 任意时点可插入，不阻塞 Gate）
```

回归命令（按变更面取最小充分集）：

```bash
pnpm build:js
pnpm --filter @laboflow/server typecheck && pnpm --filter @laboflow/server test
pnpm --filter @pi-desktop/desktop typecheck
pnpm -r --if-present test
pnpm lint
```

涉及公开契约（`/org/config-*` 新端点、`OrgBootstrap` shared 类型增字段），按 §12 需契约测试覆盖
producer（server 集成）与 consumer（desktop 单测/mock 契约）两侧；迁移 v11 按 §10 走存量库升级测试。
