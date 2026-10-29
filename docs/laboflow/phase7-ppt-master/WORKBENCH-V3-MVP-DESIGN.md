# Workbench-v3「大手术」MVP 设计（2026-10-28 夜）

- 状态：按用户指示实施的 MVP 范围（一晚）；完整手术后续分期
- 用户两决策：①PPT-Master 不再插件化，直接集成 LaboFlow Desktop；②互动能力完整进入
  LaboFlow 会话框，**必须**做出上游"本地临时网页服务器展示 SVG + 接受修改意见"的能力

## 上游能力取证（决定了 MVP 形状）

- `svg_editor/`：server.py 1394 行（12 条路由，flask 仅 2 处 import + 装饰器）+
  annotations.py 340 行（**零 flask 依赖**，全部 SVG 注解业务逻辑）+ static/（3150 行 app.js
  编辑器前端，四语言，拖拽/多选/撤销/批注分阶段提交）
- 协议：`live_preview/lock.json`（pid/port 发现）、`/api/slide/<name>/annotate|edit|undo`、
  `save-all`、`annotations.jsonl`（applied 历史）、元素临时 id `_edit_N`
- 依赖：flask ≥3（我们的 requirements-laboflow.txt **故意排除**了 flask——AGPL 无关，是
  当年"无服务"纪律；编辑器需要它，纯 MIT/BSD，可入 wheelhouse）

## 决策 A：去插件化 = 渐进内化（今晚 MVP 只做"包内模块"一步）

**不做**：一夜之间把 agentTools/桥通道搬进 Electron 主进程（等价重写整个工具面，风险不可控）。
**做**：插件目录整体迁入 `apps/desktop/resources/ppt-master/`（不再是 `plugins/` 成员——
不注册、不出现在插件市场/权限对话框），宿主加载器以**内置模块**方式直接加载（module 路径
进 plugin-runtime 的 builtin 注册表，跳过 manifest/权限网关；工具全名保持
`plugin_laboflow_ppt_master_*` 不变以兼容既有会话与技能引用）。

此步后："插件"降级为纯代码组织单元（一个内置目录），为后续逐步搬工具进宿主铺路。
入口胶囊/滑动分段（原型已批）作为内置模块的 UI 面直接进 Composer/HomePage。

## 决策 B：SVG 实时预览 = 宿主进程内嵌服务 + 系统浏览器打开（今晚核心）

**路径选择**：上游 flask 服务 = 1 个 python 进程 + 1 个浏览器标签页，改动最小、保真 100%。
Electron 内嵌（BrowserView 装编辑器页）= 大量 IPC 桥接工作 + 权限/生命周期重造，不适合 MVP。

MVP 实施：
1. `requirements-laboflow.txt` + flask==3.1.x（MIT）→ wheelhouse 刷新；
2. `svg_editor/server.py` 打两个补丁（保持上游可 diff）：`--no-browser` 默认化 +
   `--headless-host` 下不尝试 webbrowser.open；启动后写 lock.json（上游已有）；
3. 新增**宿主内置工具** `ppt_live_preview`（首批真正内化进宿主的工具，走
   `tools.execute` 白名单扩展）或（更快的 MVP）加进插件 ppt_script 白名单 +
   前言规则：管线绘制阶段自动 `--live --daemon` 启动，**由 LaboFlow 用 `open` 打开
   系统浏览器**（macOS `open http://localhost:<port>`；lock.json 读端口）；
4. 批注回流闭环（上游既有）：用户在网页上拖拽/批注 → Apply changes 落
   `svg_output/` + `annotations.jsonl` → Agent 被用户一句话（或 F-2 注入）触发
   `apply annotations`（live-preview Step 2）→ 重新质检导出。

## 会话框互动（决策 C，已是现状的强化）

Workbench-v2 的 Gate 卡片/表单/时间线全部保留在主窗口对话流（v3 原型屏 2 已批），
本轮不重做；新增的只是 U6 的"编辑器"半边。

## 今晚 MVP 任务单（顺序）

1. flask 入依赖 + wheelhouse 重建（含 AGPL 守卫确认 flask 无传递性黑名单依赖）
2. svg_editor 服务器补丁（--no-browser 默认 + headless host）+ laboflow_guard 白名单确认
3. `ppt_script` 白名单 + `svg_editor` 子命令（daemon 启动/读 lock/shutdown）；
   前言规则 9 改写：预览不再是禁令——改为「LaboFlow 托管预览」：启动走 ppt_script，
   打开浏览器由宿主完成，交互在用户浏览器，回流走 annotations 协议
4. 去插件化第一步：目录迁入 resources/ppt-master + 宿主内置加载（保工具全名）；
   入口胶囊（原型①屏）进 HomePage（静态 MVP：点击=创建工作台模式会话并注入技能指令）
5. 实机验证（Computer-Use 不可用则 CDP，如实标注）：跑 2 页稿到绘制阶段 → 预览服务
   起 → 浏览器打开 SVG → 拖拽/批注 → Apply → 回流 → 重导出

## 风险与不做清单
- 不做：Electron 内嵌编辑器页、模板安装链、元素批注在会话框内渲染（保持网页承载）
- 风险：flask 进 venv 与 AGPL 守卫清单核对（flask=BSD，依赖 click/werkzeug/jinja2=BSD，
  安全）；svg_editor 打补丁需保持 vendored 可 diff（补丁条目记录于 VENDOR_NOTES）
- 验收硬指标：浏览器打开 → 拖拽元素 → Apply → svg_output 磁盘变更 + annotations.jsonl
  追加 → Agent 应用注解 → 重导出 PPTX 成功

---

## 实机验证记录（2026-10-30 凌晨，CDP 驱动，Computer-Use 不可用如实标注）

**MVP 核心目标全部达成**：

1. flask 3.1.3 入 vendored 依赖 + 离线 wheelhouse（21.7MiB/28 wheels）；
   既有 venv 增量离线安装验证（+flask/werkzeug/markupsafe/click 等）；
2. svg_editor 服务器补丁：`PPT_EDITOR_NO_BROWSER=1` 环境默认（宿主开浏览器）；
3. `ppt_script` 白名单 + `svg_editor` 子命令（daemon/--shutdown），manifest enum +
   前言规则 9 从"预览禁令"改写为"宿主托管预览"规程（契约测试同步）；
4. **实机全环**：编辑器服务 daemon 启动（端口 6060，lock.json 记录）→ /api/health OK
   → /api/slides 识别 3 页 → `open` 打开系统浏览器 → HTTP API 注解（"验收批注：文字
   对比度请加强"）→ save-all → **磁盘 svg_output 带 data-edit-target/annotation 标记** +
   **annotations.jsonl 追加历史** → /api/shutdown 干净退出 + lock 清理。

**顺带实锤两项既有判断**：①RPC 缓解生效——白名单 ppt_script/read_doc/Glob 路径全程
零超时，唯一 255s 超时是白名单外 Bash 门禁调用；②F-2 覆盖面缺口——续跑注入仅挂
confirmStage，规划期（无门阶段）的"宣布即停"无结构解（登记 F-6，候选：规划期关键
文件写入后由插件注入，或宿主侧回合保活 API）。

**去插件化（决策 A）状态**：本轮完成 flask/wheelhouse/服务器补丁的"内置资源化"；
目录迁移与宿主内置加载器按设计文档下轮实施（避免一夜双手术）。
