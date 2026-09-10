# 计划 02：组织层嫁接（Phase 2–5）

- 日期：2026-09-09
- 前置：品牌替换完成（01）；fork 策略 = 硬 fork + 择优 cherry-pick
- 服务端：复用冻结仓库（`/Users/lance/LaboFlow Desktop`）`apps/server`（NestJS 11 + Fastify + Drizzle + Postgres，已含 auth/RBAC/网关虚拟 Key/配额/共享工作区 WS/交付物库/管理台 API，集成测试通过）与 `apps/admin-console`。**Phase 2 启动时将两目录迁入本仓库**并接入 workspace 与 CI（Postgres service）。

## 权限语义裁决的落地说明

沿用 PI-Desktop 三档语义。PRD 中的「组织策略下限」（生效模式 = max(用户选择, 组织下限)）暂缓——若后续需要，在 `crates/host-core/src/permissions.rs` 上按三档语义实现（如组织强制 ≥ accept-edits），是唯一需要 Rust 能力的点，单独排期。

## Phase 2 — 组织脊柱（约 1–2 周）

1. 服务端迁移：`apps/server` + `apps/admin-console` 迁入本仓库；`pnpm-workspace.yaml` 纳管；CI 增加 server 测试 job。
2. Electron main 新增 `electron/main/org/` 模块：
   - `org-client.ts`：登录（服务器地址+账号密码）、JWT access 30min/refresh 14d 双令牌与自动刷新、强制改密流程（must_change_password）、`/org/bootstrap` 全量拉取（角色/团队/工作区/组织渠道配置/组织 Skill 清单）；
   - 令牌存入 host-core secrets 存储（AES-256-GCM，`secrets.rs` 既有机制）；
   - 断线降级：服务端不可达 → 本地模式 + 横幅提示。
3. 渲染层：登录页（记住地址）、账号菜单（组织/团队/角色、登出）、组织资源入口。
4. IPC 契约在 `packages/shared/src/` 新增 org 命名空间（通道名沿用 `pi-desktop/org/...` 前缀，见 01 保留项）。

## Phase 3 — 组织模型渠道与配额（约 1 周）

1. 组织渠道：登录后自动注册「组织提供」Provider（网关地址 + 虚拟 Key，走 host-core `providers.rs` 既有 CRUD），模型选择器中与个人渠道并列并标注来源；默认优先级可配。
2. 配额面板：用量页新增组织配额卡片（本人/团队余量、重置倒计时、<20% 黄 / <5% 红），数据来自服务端配额余量 API；本地用量统计照常记录。

## Phase 4 — 共享工作区（约 2–3 周，最大单块）

1. WS 客户端对接服务端推流协议（工作区/会话级频道、条目序号增量同步、断线重连）。
2. UI 分两步：先做**只读旁观**（共享会话列表 + 消息流实时渲染 + 当前发言人/状态条），再开**回合制参与**（发言加锁、执行中输入框变排队发言、队列展示）。
3. 交付物库：列表/预览/下载/上传；Agent 直接写入交付物库暂缓（需过权限引擎，Phase 4 末评估）。
4. 权限三级（Viewer/Contributor/Manager）按服务端矩阵在 UI 收口。

## Phase 5 — 咨询层特性回迁（持续，按需启动）

产物卡片 → Memory/Wiki → Slide/深度研究 → 其余。每项以冻结仓库实现为蓝本重写；启动前在此文件追加裁决记录（负责范围/预期/验收）。

## 验收基准

功能验收以冻结仓库 `docs/PRD-LaboFlow-v1.0.md` 对应条目（FR-C-27/28/29/30、FR-S-01~13）+ 服务端既有集成测试为准；UI 走上游 E2E 框架补 org 场景。

---

## 执行记录（2026-09-10）

- **Phase 2a ✅**：`apps/server` + `apps/admin-console` + `packages/tsconfig` 已迁入本仓库；新增 `scripts/migrate-cli.ts`（幂等迁移）与 `scripts/seed-admin.ts`（SPEC §5.6 首启播种）及 start/dev(tsx) 脚本。自验：真实 Postgres 54/54 测试全过；boot 冒烟（healthz → 登录含强制改密 → 改密 → 重登 → org/bootstrap 含网关虚拟 Key 签发）全链路通过。
- **Phase 2b ✅（垂直切片）**：shared 新增 OrgStatus/OrgProfile/OrgBootstrap 与 `org.*` IPC；main 新增 `org-service.ts`（登录/改密/登出/状态，会话存 host 秘钥库 `org/session`，401→expired）；渲染层新增设置「组织」tab（登录表单/首登改密/已连接概览）。i18n 8 语言。
- 已知边界：服务端暂无 `/auth/refresh` 路由（P2-beta），客户端 access token 过期即要求重登；共享工作区 UI、配额面板、组织渠道注入为 Phase 3 后续。
- **超范围附带**：上游禁用 Settings 用量页的决策（ADR-0173）由本 fork 推翻并落地第一方用量页；`pi.token-insights`（市场版，sha256 校验安装 v0.4.8）与 `pi.computer`（内置 Computer Use 插件，移植冻结版实现，ESM，默认关+权限门+紧急停止）均已装载。

## 执行记录（2026-09-10，续）—— Phase 3 ✅

- **组织渠道注入**：登录/会话恢复成功后，主进程按 bootstrap 载荷自动 upsert「LaboFlow 组织渠道」Provider（vendorKey=org-gateway）：baseUrl=网关/openai/v1、虚拟 Key 经 host 秘钥库、模型列表取 orgChannels 去重；模型选择器与个人渠道并列。登出自动 providers.delete。
- **配额面板**：`GET /quota/remaining` 由桩改为真实实现（最严生效策略 × quota_counters 原子计数，含 periodEnd 重置时间）；quota-rules 新增 periodEnd + 单测；用量统计页新增组织配额卡片（团队/本人使用量、进度条、≥80% 警告、≥100% 触顶红色）。
- 自验：server 55/55（真实 PG，新增余量集成测试：团队计数 20/50、本人 tokens 850/1000 数学+阈值验证）+ desktop 1220/1220 + typecheck/lint/boot-e2e 全绿 + live API 实测（admin 850/1000 → 警告档）。
- Phase 4（共享工作区 UI）与 Phase 5（咨询层回迁）未开始，按本计划排期继续。
