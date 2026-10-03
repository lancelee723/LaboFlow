# T6.4 实机验收第二轮——可见运行 + 纯 GUI 真实输入(2026-10-03)

| 文档属性 | 内容 |
|---|---|
| 与第一轮的区别 | 本轮应用**窗口可见地运行在用户屏幕上**(AppleScript 置前台,全程保持),驱动方式为 **CDP Input 域真实输入事件**(命中测试的鼠标点击/真实键入,非第一轮的 JS DOM 注入),证据以 **OS 级 screencapture** 为主(能拍到整个桌面,证明窗口真实存在) |
| 分支 | feat/phase6-remainder(含第一轮后修复) |
| 模型 | glm-5.3-flash(真实计费调用:专家召唤 ×1、助理 ×2、slides L1 全链) |

## 结果总表

| 模块 | 结果 | 关键证据 |
|---|---|---|
| M1 专家中心 | **6/6 PASS** | 6 预设+2 团队渲染;真实点击「召唤」→对话框真实键入→「派发」→toast→**persona 真实回复**(麦肯锡语汇,marker CU-M1-liuor) |
| M2 通道卡片 + Webhook | **5/5 PASS(修复后)** | 三通道卡+Webhook 卡;粘贴整段凭证→三字段自动回填(cli_cu_m2_id 等);空值不冲掉;错误凭证分诊断(kind=credential);**Webhook 卡显示「运行中」** |
| M3 助理模式页 | **2/3 PASS** | 直派输入→真实回复(CU-M3-yuodi)✓;**重启持久性直接验证:上一轮 AC03R7 问答在多次重启后仍完整在列**(OS 截图可见);chips 空为设计内状态(账户仅会话内存,`channel_accounts` 表属规划迁移 v15) |
| M4 composer 团队空间源 | **3/3 PASS** | plus 菜单五项含新「团队空间」;子模式打开,未登录组织=正确空态(「还没有团队空间」) |
| M5 PPT L1 快速引擎 | **3/3 PASS** | 真实键入任务→agent 走 slides_plan+slides_export→**权限审批卡实点允许**→PPTX 真实落盘:`apps/desktop/slides/星澜动力欧洲进入计划_CU-M5-9rb2a.pptx`(61KB,47 OOXML 条目,unzip 校验含 notesSlides) |
| AC-06 L2 管线 | 沿用第一轮结论 | 模型长上下文停滞约束,非代码回归;L1 本轮全链通过 |

## 本轮抓到并当场修复的缺陷(3 个,均复验)

1. **Webhook 启动静默放弃**:启动 IIFE 在宿主未就绪时 `if (!h) return` 直接退出,webhook 永不在线(卡片「已停止」)。改为有界轮询(15×2s)后实机确认日志 `webhook server on 127.0.0.1:3800`,无密钥请求 401(鉴权生效),卡片「运行中」。
2. **Webhook 卡九语言键插错命名空间**:t64-i18n7 脚本锚点 `notConfigured:` 首匹配落在 `settings.<X>.status` 内,卡片渲染裸键名(`settings.assistant.webhookTitle`)。九语言全部迁回 `settings.assistant` 块,实机复验渲染正常。
3. **useAppShellRuntime 页面白名单缺 assistant**:两处 work-panel 判定未含新页(与 app-state.ts 同款代码),已补齐。

## 测试脚本自身的教训(如实)

- 导航后立即点击存在挂载竞态(助理 tab 重挂载重置面板状态)——驱动脚本改为幂等/加稳定等待。
- 设置模式下侧栏 footer 隐藏(0×0),跨页导航必须按真实用户路径(「返回应用」或点会话行)。
- 转写文本匹配要区分「权限卡输入预览」与「真实完成回执」——M5 首次匹配到的是审批卡里的 fileName,实际导出在批准后完成。

## 验证终态

desktop 3563 用例 0 fail(含本轮全部修复的回归);typecheck 0 错误。**应用保持运行中**,用户可直接查看(窗口 "LaboFlow Desktop",当前停在助理模式页,历史含三轮真实问答)。
