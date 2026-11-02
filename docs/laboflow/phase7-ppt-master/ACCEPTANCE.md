# Phase 7：PPT-Master 独立插件化 — 验收记录

- 日期：2026-10-11
- 范围：DESIGN.md（phase7-ppt-master）全部 14 个任务（T1–T14）
- 结论：**所有可自动化验收门全部通过**；实机 GUI 走查（DESIGN §9.3 场景）
  无法从开发会话内自动化执行，**待用户按 §4 清单实机运行**。本记录不将
  GUI 走查记为通过。
- 关联文档：[DESIGN.md]（主检出 `/Users/lance/LaboFlow Desktop/docs/laboflow/phase7-ppt-master/DESIGN.md`）、
  [ADR 0041](../../../adr/0041-ppt-master-standalone-plugin-repo.md)、
  插件仓库 `/Users/lance/laboflow-ppt-master`、宿主工作树 `/Users/lance/laboflow-wt-ppt`

## 1. 交付提交

### 插件仓库 `/Users/lance/laboflow-ppt-master`（branch main，39 提交 = 30 subtree 历史 + 9 新提交）

| 提交 | 任务 | 内容 |
|---|---|---|
| 34f174a | T1 | subtree 抽取（30 提交历史保留，PROVENANCE.md 溯源） |
| 7a42c30 + f8ffa4f | T2 | 重命名 `laboflow.ppt-master` v4.0.0 + 测试套件迁移 |
| 907fd77 | T3 | 独立仓库工具链（test 脚本、wheelhouse 构建器） |
| f005b83 | T8 | 技能契约：工作台唯一确认面 + daemon 禁令 |
| 85b0a25 | T9 | 首个管线工具调用自动打开工作台（特性检测 openView） |
| 71e4fb0 | T10 | 浮动确认卡退役；工作台成为唯一 UI 面 |
| 36f35ee | T11 | 工作台骨架：阶段步进条 + 运行时药丸 |
| 7bcb824 | T12 | 工作台英雄确认区（Stage1 契约 / Stage2 方向卡）；TAG `v4.0.0` |

### 宿主工作树 `/Users/lance/laboflow-wt-ppt`（branch `feat/ppt-master-plugin-extraction`，base d390cb691）

| 提交 | 任务 | 内容 |
|---|---|---|
| 3e5785392 | T4 | openView 纯 resolver |
| e3f764180 | T5 | `pi.ui.openView` 宿主 API 实现 |
| a1c109389 | T6 | 移除捆绑 slides 插件；artifacts 桥改跟新 ID（缺席 no-op） |
| 6b6c8f0cb | T7 | `plugins.bundle.json` + `fetch-bundled-plugins.mjs` pinned 构建期分发 |
| b43ebaa24 | T13 | 锁定 v4.0.0 bundle（sha256 校验） |

## 2. 自动化验收证据

| # | 验收门 | 命令 | 结果 |
|---|---|---|---|
| A1 | 插件单元/集成套件 | `npm test`（插件仓库） | 78 tests：74 pass / 4 skip / **0 fail**（4 skip 为实机 Python 条件用例） |
| A2 | 真 Python 端到端 | `PPT_IT=1 npm run test:it` | **4/4 通过**（全新 uv venv；30 页 deck 全管线在 RPC 预算内完成） |
| A3 | S10 协议回放 | `npm run e2e:s10` | **13/13 通过** |
| A4 | LaboFlow 桌面全套件 | `pnpm --filter @pi-desktop/desktop test` | **3513 tests，fail=0**（捆绑校验用例按设计条件跳过：裸仓库无 vendored 副本） |
| A5 | ppt-host 定向套件 | 同上（针对拉取的 v4.0.0 bundle 运行） | **7/7 绿** |
| A6 | bundle fetch 校验 | `fetch-bundled-plugins.test.mjs` | **3/3 通过**（id/version/sha256 门） |
| A7 | TypeScript | `pnpm --filter @pi-desktop/desktop typecheck` | **通过（0 错误）** |
| A8 | 打包冒烟 | pack dry-run | **PASS**：`plugins/laboflow.ppt-master`（vendored 语料 + 22-wheel wheelhouse）进入 `release/mac-arm64/LaboFlow.app` |

终验于 T14 复跑（见 §5 命令输出）；A1–A8 各门在对应任务评审时亦逐一通过。

### 覆盖的回归面（来自 DESIGN §9）

- 插件仓库新增四类断言：openView 特性检测降级、前言契约（asktool 禁令 +
  daemon 禁令可检索）、工作台五区结构冒烟、确认卡退役断言（manifest 无
  `ui.panel` / 无 `confirm-card.html` / 无 `openConfirmCard`）。
- 宿主仓库：openView 单测（权限门控 / 越界 view 拒绝 / 未声明 view 拒绝 /
  成功路径）、artifacts 桥新 ID 测试、条件化捆绑校验。

## 3. 决策落实核对（DESIGN §3 决策表）

| 决策 | 落实证据 |
|---|---|
| 独立仓库 + subtree 历史保留 | 插件仓库 39 提交（30 历史），PROVENANCE.md |
| ID `laboflow.ppt-master` v4.0.0 | manifest.json（`laboflow.ppt-master` / `4.0.0`） |
| 工作台单一确认面（asktool 禁令） | 技能前言契约（f005b83）+ 契约测试 |
| 首工具调用自动打开（方案 b） | 特性检测 `pi.ui.openView`（85b0a25 / e3f764180） |
| 浮动确认卡退役 | 71e4fb0 + 退役断言测试 |
| 预览 daemon 禁令 | 前言禁令 + SVG 翻页预览（T12） |
| 构建期 pinned 分发 | plugins.bundle.json（sha256）+ fetch 脚本（6b6c8f0cb / b43ebaa24） |
| 宿主耦合降级 | slides-artifacts 跟新 ID、缺席 no-op（a1c109389） |

## 4. 实机 GUI 走查清单（**待用户运行**）

> 环境限制：后台拉起的 Electron 渲染进程无法从开发会话内做 GUI 自动化，
> 故本节按"任一失败即验收失败"交给用户实机执行。全部自动化门（§2）已绿，
> 本清单是唯一未闭合项。

场景：LaboFlow Dev 安装路径版插件，茂名脚本场景。

1. LaboFlow Dev 插件设置从 `/Users/lance/laboflow-ppt-master` 安装
   （development 热重载开启）
2. `/` 菜单出现且仅出现 `laboflow.ppt-master/ppt-master`；选技能 + 上传
   茂名脚本 + Prompt
3. Agent 首个 `ppt_master_status` 后**工作台自动打开**
4. Stage 1 到达：Agent 调 `ppt_stage_submit`（转录中无 `asktool` 调用），
   工作台英雄区显示契约表；在工作台点「确认」
5. Stage 2 到达：方向卡三选一在工作台完成
6. 绘制阶段：工作台翻页可见 SVG；进程列表无预览 daemon
   （`ps aux | grep -i "preview\|daemon" | grep -v grep` 为空）
7. 质检 + 导出：`exports/*.pptx` 生成；翻为会话工件（工件面板可见）
8. 全程无浮动确认卡、无 asktool 弹窗

## 5. 终验命令记录（T14 复跑）

```bash
# 插件仓库
cd /Users/lance/laboflow-ppt-master && npm test
cd /Users/lance/laboflow-ppt-master && PPT_IT=1 npm run test:it
cd /Users/lance/laboflow-ppt-master && npm run e2e:s10
# 宿主工作树
cd /Users/lance/laboflow-wt-ppt && pnpm --filter @pi-desktop/desktop typecheck
cd /Users/lance/laboflow-wt-ppt && pnpm --filter @pi-desktop/desktop test
# 主检出构建健全性（只读，不安装）
cd "/Users/lance/LaboFlow Desktop" && pnpm build:js
```

终验结果（2026-10-11，本文件提交时全部为绿）：

- `npm test`：tests 78 / pass 74 / fail 0 / skipped 4
- `PPT_IT=1 npm run test:it`：tests 4 / pass 4 / fail 0（30 页 deck 7.3s 导出，
  全管线在预算内）
- `npm run e2e:s10`：13/13 passed
- `pnpm --filter @pi-desktop/desktop typecheck`：通过（无输出错误）
- `pnpm --filter @pi-desktop/desktop test`：tests 3516 / pass 3516 / fail 0 /
  skipped 0（fetched v4.0.0 bundle 在位，`ppt-plugin-host` 7/7 全部实跑，
  含此前条件跳过的 3 例）
- `pnpm build:js`（主检出，只读健全性）：Done

## 6. 已知遗留项

1. **宿主 RPC 预算耗尽（P4-①，DESIGN 非目标）——已闭环（2026-11-02/03）**：
   宿主结构修复落地于分支 `fix/rpc-budget-dispatch`（worktree
   `/Users/lance/laboflow-wt-rpc`，提交 530388828 + 7f78cae56）：两阶段
   预算（调度门排队单独计时）、强制权限等待上限（PERMISSION_TIMEOUT，
   结构化拒绝）、长/短工具请求槽分池（20/32）。无人值守复验 3 轮全 PASS
   （`scripts/verify-host-rpc-budget.mjs`：双并发 90s 重调用 + 轻探针风暴
   + ask 提示上限），0 次 HOST_RPC_TIMEOUT；取证与实施记录见
   [RPC-BUDGET-ANALYSIS.md](RPC-BUDGET-ANALYSIS.md) §5。

### 6a. 遗留事项闭环（2026-11-02/03，用户批准"两个遗留事项都要开干"）

| 事项 | 落地 | 验证 |
|---|---|---|
| A. RPC 宿主修复 | host-core `fix/rpc-budget-dispatch` 530388828/7f78cae56；spec 08-error-codes 同步 | cargo 707 通过；验证驱动器 3 轮 PASS（§6.1） |
| B. Exit-preview 引导 | 插件 v4.5.0（dbf49f3）：锁观察器 + 工作台状态行"预览已关闭·批注已保存"（10 分钟窗口）+ F-2 注入 Stage-2 应用批注指令；集成锁 da3785e2e | 插件 196 测试通过（含 live 链路 preview-exit-live：真实 daemon→Exit HTTP→观察器→注入→状态通道）；状态行目检待屏幕点亮 |

已知残余：验证驱动器覆盖 host-core 协议层（与真实应用同代码路径），真实
agent + 工作台的端到端目检（状态行渲染、`queue_wait_ms` 告警观测）留待
用户下次会话；PLUGIN 工具请求槽分类沿用通用池（其执行受 150s 派发上限
约束），不构成本次故障路径。
2. **实机 GUI 走查（§4）待用户运行**：8 项清单全部通过前，DESIGN §9.3
   验收不闭合。
3. **发行 CI 的 release-zip 拉取源暂缓**：`plugins.bundle.json` 当前
   source 为本地检出路径；URL 源 + 公网分发属后续发行链工作（T7 评审
   已确认按设计暂缓）。
4. **整树 sha256 暂缓**：当前为 manifest 级哈希；整树哈希按 DESIGN §8.1
   后续增强。

---

## GUI 走查执行记录（2026-10-24，自动 CDP 驱动 + 用户协作）

**结论：8 项清单全部通过**；同时登记 3 项新发现（见下）。走查档案：`/tmp/ppt-walkthrough/`（截图 01–17）。

| # | 清单项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 插件加载（构建期拉取副本） | ✅ | 启动日志 `plugin.load.success` ×2 次启动 |
| 2 | `/` 菜单唯一入口 + `/newPresentation` | ✅ | 菜单抓取：仅 `laboflow.ppt-master/ppt-master`，旧 `laboflow.slides/*` 消失 |
| 3 | 工作台自动打开（首个管线工具调用） | ✅（修复后） | 截图 12：标签自动亮起。修复提交 8621b5dcf（pluginViewActivate 事件链） |
| 4 | Stage-1 工作台确认 | ✅ | 状态机 submitted(estimate 20000)→confirmed；用户在英雄区点确认 |
| 5 | Stage-2 方向卡选择 | ✅ | 三方向卡渲染（★预选）；点卡即确认；result.json 落盘 |
| 6 | 无 asktool | ✅ | 两会话转录 0 次 |
| 7 | 导出 PPTX | ✅ | `maoming_chantou_20261024_173232.pptx`（3 页/3 备注/46.7KB，final 质检 0 阻塞） |
| 8 | 无 daemon | ✅ | 全程 + 终检 `ps` 0 个 flask/confirm_ui/preview 进程；Agent 明文援引硬规则 9 拒启预览服务（转录 [121]） |

**跨会话续跑（规则 8，计划外验证）**：会话 scratch 被回收后，Agent 在显式委托下正确重建项目并走完全程。

### 走查发现（登记，待立项处理）

- **F-2（模型顺从度）**：glm-5.3-flash 在确认门与阶段推进点反复"宣布计划即结束回合"，不执行前言的"停下轮询"；单动作外科指令可驱动，但全程需 8+ 次人工推动。候选修复：`ppt.confirmStage` 成功后由插件经 `pi.agent.complete` 注入续跑指令。
- **F-3（导出硬门旁路，Important）**：前言规则 3 教 Bash 直跑脚本（合法路径），而 Stage-2 确认硬门与工件登记（FR-PPT-06）只在 `ppt_script` 工具路径生效——本轮导出全程走 Bash，门未触发、工件未登记（artifacts 表空）。候选修复：前言将 finalize/total_md_split/svg_to_pptx 三个门禁脚本改为**必须走 `ppt_script`**（其余脚本维持 Bash 规则）。
- **F-4（测试环境摩擦，Minor）**：智能体模式下"每次询问"权限门 + 消息队列（立即发送）使外部驱动复杂化；技能前言规则 6 已提示切换 accept-edits，属预期。
