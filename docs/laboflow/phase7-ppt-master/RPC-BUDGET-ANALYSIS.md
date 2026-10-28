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
