# RPC 预算耗尽分析（走查发现 P4-①）

- 日期：2026-10-28（基于源码取证 + 两轮实机会话记录）
- 现象来源：PPT Test（2026-10-08）会话 380f7277：`host rpc budget of 270000ms
  exceeded` → 复试 330000ms → 连轻量 `echo` 的 Bash 也被拒，管线死亡。

## 一、机制是什么（源码：crates/host-core/src/rpc/mod.rs）

宿主 host-core 对**每一个 JSON-RPC 请求**施加墙钟预算（issue #1071
引入，`with_request_budget`）：

| 请求类型 | 预算构成 | 数值来源 |
|---|---|---|
| `tools.execute`（Bash 等） | 工具自身超时 + 权限等待上限 + 宽限 | `effective_timeout_ms` + `RPC_PERMISSION_WAIT_CAP_MS`(120s) + `RPC_TOOL_BUDGET_GRACE_MS`(90s) |
| 其余全部方法 | 固定 `RPC_REQUEST_BUDGET_MS` | 135s |

超时动作：`-32030 HOST_RPC_TIMEOUT`（"host rpc budget of {budget}ms
exceeded"），槽位释放；相伴的 `-32029 HOST_OVERLOADED` 是并发槽池耗尽。

**关键细节：预算从请求进入时计时，包含排队等待。** 代码注释明言预算要解决的
主要场景是"handler 等待全局状态锁"——即队列头阻塞。观测到的 270s/330s 即
Bash(60s/120s 请求超时) + 120s + 90s。

## 二、为什么会发生在 PPT-Master 管线上

三个因素叠加：

1. **调用密度与时长**：一次 3 页 deck 全程 60–120 次工具调用，其中重 Python
   （validate/quality_checker/finalize/svg_to_pptx）单次 30–120s；每次都是
   一个长占用槽位的 tools.execute。
2. **排队计入预算**：宿主侧持久化/状态锁与并发槽池（容量有限）在密集长调用
   下拥塞；**排队中的请求预算同样在烧**——自己很轻也可能超时死亡（这就是
   "连 echo 都被拒"的成因：不是累计配额用完，而是槽池/锁被长请求占满，
   后到者排队至超时）。
3. **前台 daemon 是毒丸**（已修）：上游"实时预览服务"以前台 Bash 启动，
   永不返回 → 每次尝试烧满一整个预算槽，还叠加权限等待。硬规则 9 已禁。

## 三、已落地的缓解（本轮）

- **daemon 禁令**（硬规则 9，v4.0.0）：最大毒丸移除，预览由工作台承担。
- **ppt_script 优先**（v4.1.0，硬规则 3 修订）：9 个白名单脚本一律走
  `ppt_script`——其内建"同步 60s → 后台作业 + 轮询"转换把每个
  tools.execute 压到短执行，不再长占槽位；Bash 只留给白名单外辅助命令。
- **分块写入**（v4.0.1）：单次输出不超限，避免整轮重试风暴。
- **F-2 续跑注入**（v4.1.0 + 宿主 `session.continueFromPlugin`）：确认后
  回合自动恢复，减少人工重试带来的重复重调用。

## 四、宿主侧结构修复提案（需单独立项，改 host-core）

根因是**预算计时包含排队**与**全局锁/槽池粒度过粗**。候选方案（按侵入度）：

1. **预算从 dispatch 起算**（推荐起点）：`with_request_budget` 的时钟改为
   从实际开始处理（拿到锁/槽）起算，排队时间不计。改动集中在 rpc/mod.rs
   的 permit 获取与计时起点；需要补"排队饥饿"保护（等待上限单独计）。
2. **锁范围收窄**：审计 handle_request 内全局状态锁的临界区，把长 IO
   （持久化写、子进程等待）移出锁外——排队本身的根源。
3. **tools.execute 槽位分类**：长工具（Bash≥60s）与短工具分池，短调用
   不被长调用饿死。

验证口径：以 PPT-Master 全管线跑 3 轮（10-08 复现配方：双并发重 Python +
daemon 尝试）零 HOST_RPC_TIMEOUT 为通过标准。

## 五、宿主侧修复落地记录（2026-11-02，分支 fix/rpc-budget-dispatch）

### 5.1 实施前补充取证

- RPC 层全部 ~200 个 `state.lock()` 临界区均为**纯同步**（脚本扫描：守卫
  存活期间无任何 `.await`；DB 是单 rusqlite Connection，本就要求经全局锁
  访问）——不存在"锁内长等待"的处理器。排队长的现实来源是**同步临界区
  在写入压力下变慢**（WAL checkpoint、大 transcript 写入）与 32 个请求槽
  被长工具执行全程占用的叠加。
- 权限等待 `pending_rx` **没有自己的超时**：`RPC_PERMISSION_WAIT_CAP_MS`
  (120s) 只是预算余量，不是强制上限。无人应答的 ask 提示会烧满整个工具
  预算（echo=270s），且预算杀死 handler future 时**泄漏已注册的待审批
  权限**（清理代码永远不执行）。
- 工具执行准入（`tool_budget.rs`）已按 Read/Mutation/Shell/Plugin 分类，
  排队上限 30s——提案 ③ 的"执行层分槽"已存在；缺的是**请求槽层**的分类。

### 5.2 已实施（rpc/mod.rs）

1. **两阶段预算（提案 ①）**：`handle_request` 拆为调度门（entry 锁 +
   handshake 检查，`RPC_QUEUE_BUDGET_MS` 135s，超时报 "queue wait …
   never dispatched"）与处理阶段（`with_request_budget`，从 dispatch 起算）。
   固定预算方法保持"排队+处理 ≤135s"的 #1071 总量保证（排队时间从处理
   预算中扣除）；tools.execute 不扣——排队不计入正是本次修复的意义。
   门等待 ≥2s 打 warn 日志（`queue_wait_ms`），实机可证伪锁竞争假设。
2. **强制权限等待上限（提案 ① 的饥饿保护）**：权限 select 增加
   `RPC_PERMISSION_WAIT_CAP_MS` (120s) 超时臂——取消待审批、结构化拒绝
   （共享错误码 `PERMISSION_TIMEOUT`，RACP 映射 `APPROVAL_EXPIRED`），
   不再假手预算杀死请求。规范已同步
   （docs/spec/03-runtime/08-error-codes.md）。
3. **请求槽分池（提案 ③）**：长工具（tools.execute 有效超时 ≥60s，
   `is_long_tool_request`）从专用池（20 槽）取槽；其余请求保持 32 槽
   通用池。长调用不再挤占短调用的入口。执行层并发仍由 ToolBudget 约束。
4. **提案 ②（锁临界区收窄）**：取证结论为 RPC 层无锁内长 IO（见 5.1），
   无需收窄；唯一确认的锁内长 IO 在 config_sync `domains::capture`
   （文件+加密，调度器节拍内），与本次故障路径无关，**不改**，留观。
   替代交付：门等待日志（上 1）使锁竞争在实机可观测。

### 5.3 测试与验证

- `cargo test -p host-core --locked`：707 通过（新增：长/短池分类、
  queue budget 超时/直通两测；既有 #1071 预算行为测试全数保持）。
- `cargo fmt --check` / `cargo clippy`：无新增告警（仓库基线本有 47 处
  fmt 漂移，本次未扩散）。
- 实机复验（3 轮管线零 HOST_RPC_TIMEOUT）见下节，随遗留 B 一并跑。

### 5.4 实机复验记录（2026-11-03，补验证驱动器）

`scripts/verify-host-rpc-budget.mjs`（随本提交入库）：以 stdio JSON-RPC 直接
驱动本仓库构建的 host-core 二进制（scratch 数据目录 + 预置市场目录缓存），
把 10-08 复现配方转成无人值守口径：

- **R1 双并发重调用**：2×`python3 time.sleep(90)`（Bash，timeoutMs 110s，
  长 20 槽池）。
- **R2 轻调用风暴**：重调用运行期间 6×`echo probe-N`（timeoutMs 10s，短
  32 槽池）+ 穿插固定预算方法（commandShells.list）。
- **R3 无人应答 ask 提示**：ask 会话的 Bash 调用不审批，应于 ~120s 收到
  结构化 `PERMISSION_TIMEOUT` 拒绝（非 -32030），且 `permissions.pending`
  清空。

判定：全程 0 次 -32030；轻探针在重调用运行中每发 <15s；R3 按文档落地。

**结果：3 轮全部 PASS**（每轮独立 scratch 配置）：

| 轮次 | budgetKills | 探针延迟（6 发） | 重调用时长 | 权限上限 |
|---|---|---|---|---|
| 1 | 0 | 20–24ms | 126.2s（并发） | PERMISSION_TIMEOUT @120.004s，pending=0 |
| 2 | 0 | 11–15ms | 126.1s（并发） | PERMISSION_TIMEOUT @120.003s，pending=0 |
| 3 | 0 | 18–24ms | 126.1s（并发） | PERMISSION_TIMEOUT @120.005s，pending=0 |

对比基线：修复前同型负载下轻 `echo` 被预算在 270s 处杀死（§一）。
排队门等待日志（≥2s）三轮均未触发——scrath 直驱下全局锁无竞争热点，
与 §5.1 取证（锁内无长 IO）一致；真实应用内观测留待用户下次会话。

### 5.5 遗留 B 验证（preview-exit 引导链）

插件仓 `test/preview-exit-live.test.mjs`（需已配置运行时，CI 跳过）：
真实 venv → `ppt_script svg_editor daemon` → `live_preview/lock.json` 出现
→ 向 `/api/shutdown` 发 reason=exit-preview（Exit 按钮的真实调用）→ 服务
释放锁退出 → 观察器 3s 轮询捕获 → `session.continueFromPlugin` 注入
Stage-2 应用批注指令（reason=preview-exit-annotations）→ `ppt.getPreviewStatus`
返回 closedRecently + annotationsSaved → 同一预览会话去重。单元层
（纯函数/通道契约/渲染优先级）由 `preview-watch.test.mjs` 覆盖；工作台
状态行的实际渲染待用户下次点亮屏幕后目检。
