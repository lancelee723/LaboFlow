# T6.4 实机验收报告(第一轮,2026-10-03)

| 文档属性 | 内容 |
|---|---|
| 分支 | feat/phase6-remainder @ 工作树 laboflow-t64x(17 任务提交 + 2 轮收尾提交) |
| 方式 | 桌面实例 `electron out/main/index.js --remote-debugging-port=9222`(构建产物 + 真实用户 userData + 真实 LLM glm-5.3-flash),CDP 驱动渲染层实点/断言,关键状态 OS 级留档 |
| 证据目录 | 本目录(ac01*/ac03*/ac04*/ac06-*.png + ac06-script.md) |
| 结论 | **AC-01 ✓ 9/9;AC-04 Tier-1 ✓ 3/3;AC-03 核心 ✓ 3/3;AC-06 未走通(如实列明);AC-02/05 环境阻塞** |

## AC-01 专家与专家团 — ✓ 通过(9/9)

导航专家中心 → 6 预设专家("PPT制作师"以无空格形态渲染,计达标)+ 2 专家团 + 三 Tab 结构 ✓;召唤 战略规划分析师 → 对话框提交(派发 toast)→ **真实 LLM persona 回复**(麦肯锡方法论语汇,任务标记匹配)→ 专家会话持久可回访 ✓。截图:ac01-step1/step4/step5/ac01v2-*。

## AC-04 IM 通道 Tier-1 — ✓ 通过(3/3)

粘贴一段自动识别:整段凭证文本 → App ID/App Secret/Verification Token 三字段自动回填 ✓;空值保存不冲掉语义的 UI 占位提示在场(语义单测已锁)✓;错误凭证连接给出**分诊断**(kind=credential,"凭证无效: 缺少 app_id / app_secret…",非笼统失败)✓。截图:ac04-*。

## AC-03 助理模式(可执行子集)— ✓ 通过(3/3)

侧栏助理入口在;通道状态 chips 如实显示(未接通道 → 引导文案);直派输入真实 LLM 一句话回复 ✓;统一历史容器在(重启持久性由会话机制保证,重启复验留下轮)。截图:ac03-step1/ac03-reply。

## AC-06 PPT 全链 — ✗ 未走通(如实列明,非代码回归)

脚本稿注入 composer → 发送 ✓(ac06-step1);agent 自主走 L2 管线:attribution_guard 等 ask 审批由验收驱动循环实点批准,Stage-1 沟通契约完整产出(受众成效/核心信息/画布 ppt169)并提交门禁 ✓;**会话内确认送达后,agent 新回合停滞 25+ 分钟无输出**(README 已知约束:glm-5.3-flash 长上下文空响应,10-02 记录的「单页/轮」缓解依赖模型配合)。PPT 管线代码本批仅加法改动(白名单/预估/预算),无回归面。处置:换模型档或分页续跑后补验,验收驱动脚本已归档(.acceptance-tmp/ac06-*.mjs)。

## AC-02 / AC-05 — 环境阻塞

AC-02 需组织 server + 真实 PG(docker daemon 未运行);AC-05 需 WeKnora 实例。两项留待环境就绪后补验(空间/KB 的代码级测试为全绿,见分支提交)。

## 实机抓到并当场修复的缺陷

1. **六个新 IPC handler 形参误用**(assistantSessionGet/History/Send/WebhookGet/Set/spaceClip):挂在无 event 的 `laboflowHandle` 上却消费 event 断言 sender → `assistantSessionGet` 实机必炸"Cannot read properties of undefined (reading 'sender')",助理页发送按钮永不可用。全部改挂 `laboflowHandleWithEvent` 后复验通过(助理会话创建返回 sessionId ✓)。
2. 次生发现(清理提交):`settleUnattendedAsk` 未接线(降级定时器在人工批准后不清)等 7 项,见 refactor 提交。
