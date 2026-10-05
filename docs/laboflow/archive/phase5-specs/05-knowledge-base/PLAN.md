# PLAN：接入知识库（模块 05）

| 文档属性 | 内容 |
|---|---|
| 版本 | v1.0（草案） |
| 日期 | 2026-09-11 |
| 关联 | [PRD](PRD.md)、[SPEC](SPEC.md)、[Phase5 总览](../README.md) |
| 依赖 | 既有 MCP 体系（user-mcp.ts / mcp_servers.rs）与 browser-view；T55.2 组织下发依赖 org bootstrap 通道（既有） |
| 工期估算 | 约 3–4 周（2 名工程师）；体量最小、依赖全现成 |

> 任务格式：**T55.x 任务名**（S/M/L）— 验收标准。

---

## 批次 A：MCP 检索通道与引用体验（M-KB1）

- **T55.1 知识库设置 tab（个人侧）**（M）：设置新 tab「知识库」：「检索服务（MCP）」登记表单（名称/传输/URL/凭证；复用既有 MCP 表单组件与保存链路）+ **连接测试**（listTools 探活：成功回显工具清单，失败分诊断 network/auth/incompatible）；「WeKnora 部署与接入指引」内置文档页（docker compose 命令/API Key 获取/tencent-weknora-mcp 的 HTTP+X-API-Key 配置样例，可直接复制）。— 验收：FR-KB-01/03；真实 WeKnora 实例探活通过；错误分诊断三态可复现。
- **T55.2 检索引用卡与提示词契约**（M）：MCP 工具结果渲染扩展——检索类工具（含 `hybrid_search` 等按工具名/返回结构启发式识别）结果折叠为引用卡列表（来源/文档/片段/分数，≤50 条虚拟滚动）；系统提示词追加「引用契约」条款（事实陈述后标注 `[引用:n]`，提示词组装点=`composeSystemPrompt` 行为子句）；引用卡「打开来源」动作（URL 存在时经内嵌浏览器打开，T55.4 就绪前降级为外部浏览器）。— 验收：FR-KB-04；WeKnora 实测回答带 `[引用:n]` 且卡可跳转；非检索类 MCP 结果渲染不回归。
- **T55.3 MCP 注册表来源扩展与豁免**（S）：**不建平行注册表**（R5-10）：`mcp_servers` 既有表加 `source`（`user`|`org`）与 `org_id` 列（迁移 v16）——组织下发条目 source=org、不计入个人 16 上限（上限校验改按 source=user 计数）；知识库网页 URL 列表存 host **kv**（键 `kb.urls`，PI-Desktop 既有 kv 存储，不建表）；`pi-desktop/kb/*` IPC 为 `mcp_servers`（含来源过滤）与 kb.urls 的视图封装。— 验收：登记 20 个组织下发服务不触上限且个人配额不受挤占；连接状态机与既有 MCP 页一致；kv 读写单测。

**Gate M-KB1**：自部署 WeKnora（docker compose）端到端：上传 PDF/Word/Excel → 会话检索 → 引用回答 → 无崩溃；lint/typecheck/test 全绿。

## 批次 B：组织下发与内嵌浏览器（M-KB2）

- **T55.4 知识库内嵌浏览器面板**（M）：browser-view 复用扩展：独立 partition `persist:kb-browser`（与 `persist:work-browser` 隔离）；侧栏/工作区左栏「知识库」入口 → 打开知识库面板（URL 来源：组织下发项/个人配置列表）；地址栏（只读展示 + 列表内跳转）、导航按钮、多标签；下载拦截（session will-download）→ 保存对话框（默认下载目录/项目目录二选）→「带入会话」动作（文件进当前会话附件）。— 验收：FR-KB-06~08；登录态跨重启保留；下载-带入链路 E2E；崩溃隔离（杀 view 不影响主窗）。
- **T55.5 服务端组织下发**（M）：`apps/server` org settings 扩展：`org_kb_servers` 表 + 管理台「知识库」配置页（类型 MCP/网页 URL、名称/地址/Key（加密）/说明/启用/范围（全员|团队））；bootstrap 载荷新增 `kbServers[]`（Key 以服务端加密信封下发）。— 验收：FR-KB-10/11；RBAC 集成测试；停用后成员侧即时失效（下次 bootstrap）。
- **T55.6 客户端组织下发接入**（S）：OrgService 处理 `kbServers[]`：MCP 项 → `mcp_servers` upsert（source=org，Key 落 host secrets，只读保护）；网页项 → `kb.urls` kv 列表（组织标记）；登出停用不清个人项。— 验收：FR-KB-02；成员登录零配置出现检索服务与网页入口；Key 全链路密文（抓包+落盘检查）。

**Gate M-KB2**：组织链路 E2E（管理台配置 → 成员登录 → 检索/浏览可用 → 停用生效）；内嵌浏览器三平台（Win/mac/Linux）渲染回归。

## 批次 C：打磨（M-KB3）

- **T55.7 多库路由与用量**（S）：会话内知识库服务选择器（FR-KB-05）；kb 工具调用进用量维度（FR-KB-14）。— 验收：多服务并存按选择路由；用量页新增知识库维度卡。
- **T55.8 收尾**（S）：网络代理遵循复查（NFR-KB2/FR-KB-09）、i18n 8 语言、用户手册「知识库接入」章（含 WeKnora 部署附录）。— 验收：Gate KB 清单。

**Gate KB（模块出口）**：见 PRD §6。

## 里程碑总览

```
M-KB1（约 1.5 周）→ 个人 MCP 通道 + 引用卡 + WeKnora 指引
M-KB2（约 1.5 周）→ 组织下发 + 内嵌浏览器面板
M-KB3（约 0.5–1 周）→ 打磨 → Gate KB
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| WeKnora MCP 工具返回结构变化 | 引用卡识别做双启发（工具名 + 返回 JSON 结构字段探测），未识别降级为普通工具结果（不失败） |
| 内嵌浏览器与工作浏览器 session 串扰 | 独立 partition 硬隔离；验收含 cookie/缓存隔离用例 |
| 组织 Key 泄漏面 | 服务端加密信封 + 客户端 secrets + UI 不回显 + 审计三件套；渗透用例进 Gate |
| 第三方网页端兼容性（下载/跳转） | 白名单域内宽松处理；异常站点降级「在系统浏览器打开」按钮 |
