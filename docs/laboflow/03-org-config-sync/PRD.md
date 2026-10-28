# PRD：组织配置持续同步与按人授权（模块 03）

| 文档属性 | 内容 |
|---|---|
| 产品名称 | LaboFlow 组织配置同步（Org Config Sync）与资源按人授权 |
| 文档版本 | v0.1（草案） |
| 撰写日期 | 2026-10-30 |
| 文档状态 | 待评审 |
| 目标读者 | 产品、研发、测试 |
| 关联文档 | [组织集成计划](../02-org-integration-plan.md)（本模块是其 Phase 2 bootstrap 的直接续篇）、[模块 01 专家与专家团](../phase5/01-expert-center/PRD.md)（FR-E-18/19 组织专家包）、[模块 05 知识库](../phase5/05-knowledge-base/PRD.md)（FR-KB-02/10/11 组织下发）、[PLAN](PLAN.md) |
| 对标来源 | [Octop-Enterprise](https://github.com/colorAi/Octop-Enterprise)（2026-10-30 调研，机制映射见附录 A） |

---

## 1. 背景与定位

### 1.1 现状缺口

组织资产下发目前是**登录时一次性 bootstrap**（`GET /org/bootstrap`，T2.10）：组织渠道、网关虚拟 Key、组织技能、KB 条目、组织专家包、PPT 模板包随登录交付。由此产生两个真实问题：

1. **变更不可达**：管理员调整渠道/专家包/KB/模板后，已登录客户端要等到下次登录才能看到——日常使用中桌面端长期在线，等于「改了没人知道」。
2. **粒度太粗**：组织专家包全量下发给所有登录用户（`expertPacks.deliveryFor()` 无过滤）；渠道与 KB 只支持「全量 / 按团队」两档；模型授权在网关侧无按人校验。无法表达「只给某位顾问开某个专家包」「收回某员工的某个 KB」这类最常见的运营动作。

### 1.2 对标结论（Octop-Enterprise）

Octop Enterprise 用两套机制解决了同样的问题，且与 LaboFlow 的架构假设兼容：

- **client-config 三端点 + revision 摘要**（`/client-config/status|publish|apply`）：revision 是对「角色+权限+策略+发布说明+资源分配」的确定性哈希；服务端推空载荷 WS 事件，客户端比对 revision 后决定是否刷新；管理员可发布带说明的更新公告。
- **employee_resources 按人资源分配**：模型/专家/技能逐员工 deny-by-default；分配带 revision；撤销权限时掐断在途模型流；部门调岗两阶段调和收回越界资源。

### 1.3 本模块定位与适配原则

组织层补强，不新增产品面。把 Octop 的机制移植到 LaboFlow「**桌面端重执行**」架构上时，遵循三条适配原则：

1. **服务端始终按当前权限裁决**（下发过滤只是体验优化，强制在服务端：网关、bootstrap、既有各模块路由）。
2. **配置应用分层**：UI 级配置（专家目录、KB 勾选、模板列表）热刷新；**运行时级配置（org 模型渠道/虚拟 Key、KB MCP 注入、专家包副本）在回合边界应用**——LaboFlow 的 org 渠道/MCP 是注入 agent-runtime 的运行时状态，不能像 Web UI 一样随时热替换。
3. **兼容优先的 deny-by-default**：引入按人授权，但「无显式按人记录 = 与现状完全一致」；Octop 式「无策略=无资源」的激进默认**不做**（见 §4）。

## 2. 用户与场景

- **US-OC01** 作为组织管理员，我想给某位顾问单独授予「尽调专家包」（其团队未开）——该顾问的客户端在一分钟内收到「企业配置有更新」，确认后专家目录出现该专家，无需重新登录。
- **US-OC02** 作为组织管理员，我收回了某员工的某个 KB 条目/模型渠道——该员工正在跑的回合不被打断；下一回合起该资源不可用（模型请求返回可读的 403，KB 检索工具从工具面消失）。
- **US-OC03** 作为组织管理员，我发布一条带说明的配置更新（「新增 Q4 模型渠道，详见附件」）——在线员工看到提示与说明，可「立即更新」或「稍后」；点「稍后」后同一版本不再反复打扰。
- **US-OC04** 作为员工，我离线（或合盖）期间配置发生了变化——重新联网/登录后客户端比对出 revision 差异并提示更新。
- **US-OC05** 作为组织管理员，我把某员工调到另一个团队——他的资源集合随新团队的默认集变化，客户端同样收到更新提示。
- **US-OC06** 作为组织管理员，我误收回了资源——在审计日志中可查到操作记录，重新授予即可恢复。

## 3. 功能需求

优先级：M / S。

### 3.1 配置状态与发布（子域 A：持续同步）

- **FR-OC-01（M）** `GET /org/config-status`：返回 `{ revision, message, publishedAt, pending }`。
  - `revision` = 对该用户的**有效资源集**（orgChannels / expertPacks / kbServers / slideTemplates / orgSkills + 按人授权 + 最新发布记录 id）做确定性 sha256；任何会影响该用户的变更必然改变 revision，无关变更不改变（含他人资源变更）。
  - 响应 `Cache-Control: no-store`；员工只能读取自己的状态；**不回传任何密钥明文**（与 bootstrap 交付同界）。
- **FR-OC-02（M）** `POST /org/config-publish`（仅 sys_admin）：可选 message ≤500 字；发布记录落 `org_config_releases` 表 + 审计 `config.publish`；发布使所有用户的 revision 变化。
- **FR-OC-03（M）** 客户端同步回路：登录后拉取一次；此后在**组织 WS 重连、主窗口聚焦、60s 兜底轮询（间隔可配、±20% 抖动防惊群）**三个触发点拉取比对。revision 不变则静默；变化则去重提示「企业配置有更新」（展示 message 与发布时间），提供「立即更新 / 稍后」；「稍后」对同一 revision 不再弹出，下次变更再次提示。
- **FR-OC-04（M）** 配置应用分层：
  - UI 级：专家目录、KB 勾选面、模板列表、配额面板——立即热刷新。
  - 运行时级：org 模型渠道与虚拟 Key、KB MCP 注入（`mcp.upsert source=org`）、组织专家包副本（`setOrgPacks`）、模板包——在**回合边界**应用（重放既有 bootstrap 消费链，动作幂等）；存在进行中回合时提示「当前任务完成后应用」并保持 pending。
  - 应用完成后回写已应用版本（FR-OC-11），`pending` 清零。
- **FR-OC-05（S）** `GET /ws/org` 组织级推送通道：JWT 鉴权，发布/授权变更时向在线客户端广播 `{type:"org.config.changed"}` **空载荷事件**（只表达「去重新拉取」，不携带他人信息）。无此通道时 FR-OC-03 的轮询兜底已可独立成立。

### 3.2 资源按人授权（子域 B：兼容版 deny-by-default）

- **FR-OC-06（M）** 授权模型：新表 `user_resource_grants(user_id, kind, resource_id, effect, updated_by, updated_at)`，`kind ∈ model-channel | expert-pack | kb-server | slide-template`，`effect ∈ grant | deny`。
  - **有效集 =（既有默认集 ∪ 该用户 grant）− 该用户 deny**；默认集即现状语义（渠道 assign mode=all/teamIds、KB scope=all/teams、专家包=全量 enabled、模板=全量 enabled）。
  - 无任何 grant/deny 记录时，下发结果与今天**逐字节一致**（兼容红线）。
- **FR-OC-07（M）** 模型按人强制：网关在 `authenticate` 之后、`route` 之前按 vkey→user 校验请求模型是否在该用户有效渠道集内，未授权返回 `403 EMODELNOTALLOWED`（可读错误，含所需模型名）；`/org/bootstrap` 的 `orgChannels` 同步按有效集过滤。
- **FR-OC-08（M）** 专家包/KB/模板下发过滤：`expertPacks.deliveryFor(userId)`、kb `deliveryFor(userId, teamId)`、模板查询接入有效集计算；撤销的资源不再进入 bootstrap 交付。
- **FR-OC-09（M）** 管理台：用户页新增「资源授权」编辑器——三类（渠道/专家包/KB）+ 模板资源列表，每项显示**有效来源徽章**（团队默认 / 单独授予 / 单独收回）；保存为该用户该 kind 的**整体替换**语义（对齐 Octop，`[]` 即清空个人覆盖），携带乐观锁 `expectedRevision`，冲突 409 重读。系统设置页新增发布区（message 输入 + 发布按钮 + 最近发布记录）。
- **FR-OC-10（M）** 审计：授权变更（操作者/对象用户/kind/resource/effect）、发布、客户端 apply（user + revision）全量进 `audit_logs`。
- **FR-OC-11（M）** `POST /org/config-apply`：客户端应用完成后回写 `{revision}`；服务端记 `org_config_applied(user_id PK, revision, applied_at)`；`config-status.pending = (applied.revision !== 当前 revision)`。

## 4. 范围裁决（明确不做）

| 事项 | 裁决 |
|---|---|
| 多租户（SaaS 式多组织隔离） | 不做：维持单组织 + 团队模型（Octop 同样是单组织+部门，无可借鉴实现） |
| 「无策略=无资源」激进默认（Octop 式 deny-by-default 组织开关） | v1 不做：会改变所有现存用户行为；v1 仅兼容语义（§3.2），若试点需要再立组织开关另议 |
| LDAP / OAuth / OIDC SSO | 另行立项（Octop 有现成文档可参考，但与本模块无依赖） |
| 调岗两阶段调和（pending_scope / operation_id / 越界资源回收事务） | v1 不做：调岗=管理员改团队，revision 自然变化触发同步；两阶段机制列入观察 |
| 内置自建知识库（pgvector） | P2 另立项（对标结论中的 #3 建议），本模块只做 KB **条目**的按人授权 |
| 配置回滚 / 版本历史 UI | 不做：审计已可追溯，重新授予/重新发布即可恢复 |
| 桌面端程序自身升级 | 不做：沿用既有构建与安装包发布流程；配置更新绝不触发安装/重启（对齐 Octop 边界） |
| 撤销时掐断在途模型流（Octop cancel_streams） | v1 不做：LaboFlow 模型调用经网关按请求校验，在途回合允许完成、新回合拒绝即达成同等安全目标，且不破坏回合完整性 |

## 5. 非功能需求

| # | 需求 |
|---|---|
| NFR-OC1 | 性能：config-status P95 <100ms；revision 计算 O(该用户资源数)，可做 per-user 60s 缓存；轮询默认 60s ±20% 抖动，间隔可配；网关强制新增开销 <5ms/请求 |
| NFR-OC2 | 兼容：旧客户端（不调 config-status）行为完全不变；新客户端对旧服务端 404 时静默降级为无提示；grants 空表时 bootstrap 输出与现状逐字节一致（差分测试固化） |
| NFR-OC3 | 安全：status/publish/apply 均 JWT 鉴权；publish 与授权变更仅 sys_admin（team_admin 是否可授权本团队成员=待评审，默认否）；status 不含密钥明文；全部安全事件入审计 |
| NFR-OC4 | 一致性：有效集以服务端为唯一真相，客户端仅缓存；撤销后新回合强制拒绝、在途回合允许完成；`pending` 语义保证客户端可感知「落后于服务端」 |

## 6. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M-OC1 | 子域 A 全部 + 子域 B 的服务端过滤 | FR-OC-01~05、08、11；revision 矩阵单测（渠道/包/KB/模板/授权/发布任一变更 → 该用户 revision 变，他人不变）；E2E「管理员发布 → 在线客户端提示 → 应用 → pending 清零」 |
| M-OC2 | 子域 B 网关强制 + 管理台 | FR-OC-06/07/09/10；有效集矩阵测试（默认/授予/收回 × 四类资源）；网关越权 403 集成测试；管理台乐观锁冲突测试；「撤销 → 下一回合边界生效」E2E |

**Gate OC（模块出口）**：全部 M 级验收；既有 bootstrap 消费方回归全绿（expert/kb/space/admin 切片）；渗透用例：员工无法读取他人 status、无法自授、无法经直连网关调用未授权模型；兼容冒烟：grants 空表差分断言 + 旧客户端语义不变。

## 7. 名词术语

| 术语 | 定义 |
|---|---|
| revision | 用户有效资源集 + 最新发布记录的确定性哈希；客户端据此判断「配置是否变化」 |
| 发布（publish） | 管理员触发的显式更新公告（可带说明），使全体用户 revision 变化 |
| 授予 / 收回（grant / deny） | 按人授权的两个效果：在默认集之外追加 / 从有效集中移除 |
| 有效集 | 该用户实际可用的资源集合 =（默认集 ∪ grant）− deny |
| 回合边界应用 | 运行时级配置在一个 Agent 回合结束后的安全时点应用，不打断在途回合 |
| pending | 服务端记录的「客户端已应用版本」落后于当前 revision 的状态 |

---

## 附录 A：Octop-Enterprise 机制映射

| Octop 机制 | 本模块对位 | 取舍 |
|---|---|---|
| `GET /client-config/status`（revision/权限/摘要） | FR-OC-01 | 简化：LaboFlow 暂无细粒度权限体系，revision 只覆盖资源集与发布 |
| `POST /client-config/publish`（公告+审计+广播） | FR-OC-02 | 全量采纳 |
| `POST /client-config/apply`（applied 标记 + 409 冲突） | FR-OC-11 | 简化：不做 409 冲突重试，apply 幂等重放 |
| WS `client_config_changed` 空载荷事件 + 30s 轮询 + 聚焦/重连检查 | FR-OC-03/05 | 采纳；轮询为 P1 主路径，WS 为 S 级优化 |
| 忙碌保护（任务进行中阻止刷新） | FR-OC-04 | 适配为「回合边界应用」，更贴合桌面重执行架构 |
| `employee_resources` 按人分配 + revision 调和 + 越界回收 | FR-OC-06/08 | 采纳分配与有效集计算；两阶段调和 v1 不做 |
| 网关/服务端逐请求权限裁决 | FR-OC-07 | 采纳（模型渠道级；v1 不做模型单粒度） |
| deny-by-default（无策略=无资源） | §4 裁决 | v1 不做，兼容优先 |
| cancel_streams 掐断在途流 | §4 裁决 | 不做，回合边界拒绝达成同等目标 |
| 专家定义只读私有实例 | 已有 | 组织专家包只读副本（FR-E-19）已落地，无需改动 |
