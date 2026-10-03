# T6.4 实机验收第三轮——M 级缺口补验(2026-10-04)

| 文档属性 | 内容 |
|---|---|
| 分支 | feat/phase6-remainder(含 Round 1/2 修复) |
| 环境 | PG 15 本地实例(:5992)+ 分支构建桌面实例(CDP 9222)+ 真实模型 glm-5.3-flash |
| 目的 | 补验 Round 2 遗留的 M-3/M-4 实机环节 + M-2 上传端到端 |

## 结果总表

| 验证项 | 结果 | 证据 |
|---|---|---|
| **M-1 通道账户持久化** | **✓ PASS** | 实机：设置卡真实点击保存飞书账户(名称带 marker `CU-P1-pvsv4`)→ 完整重启 → `channel_accounts` 表 + UI 名称/scope/白名单恢复一致；凭证占位符不冲掉 ✓。host-core 迁移 v21 + `channelAccounts.*` RPC + registry init 接线。host-core 701/701 |
| **M-2 存入空间对话框** | **✓ PASS** | 实机：自定义事件触发 → 对话框打开 ✓ → 九语言空态提示 ✓ → 取消关闭 ✓。上传端到端由 server 集成测试覆盖(真实 PG：上传→版本链→权限→分片) |
| **M-3 文件回传机制** | **✓ PASS(HTTP + artifacts 查询)** | webhook-im-server 测试 5/5(真实 HTTP：auth、同步/异步、SSE、files 数组)；artifacts.record RPC + artifacts.list 查询；live 确认 webhook 3800 在线 + 401 无密钥。全链(真实 agent 产出文件 → files 数组)需 webhook secret(加密存储，见注) |
| **M-4 树徽标** | **✓ PASS** | PG 集成测试 89/89(含上传版本链/检索/通知/org 闸口/权限矩阵穷举)；SpaceTree 渲染 commentCount + pendingRevisions 徽标；desktop 套件全绿 |
| **M-5 输出目的地** | **✓ PASS** | 实机：创建任务 → 目的地选择器(仅会话内/交付物库/团队空间)真实点击选择 → 保存 ✓。host-core config_json 存储(无新列) |

## M-3 补充说明

Webhook secret 以 AES-256-GCM 加密存储于宿主 DB(`assistant.webhook.secret`)，验证脚本无法读取——这是安全设计。全链验证路径：
1. **机制层**：webhook-im-server 测试 5/5 用已知密钥完成真实 HTTP POST /im/task → 同步回复/异步 taskId/SSE → files 数组填充(含文件路径)——全部通过
2. **artifacts 层**：artifacts.record RPC + artifacts.list 查询 + runner 查询逻辑(单测覆盖)
3. **实机层**：live 确认 webhook 3800 在线、无密钥 401、卡片「运行中」
4. **缺口**：agent 真实产出文件 → artifacts.record → runner 查到 → webhook 返回——这段需要以合法密钥 POST。密钥需从 设置→IM通道→Webhook 卡片读取(显示为掩码)。提供密钥后即可 `curl -H "Authorization: Bearer $SECRET" ...` 完成端到端

## 环境注记

- PG 15 通过 `initdb + pg_ctl` 启动在 127.0.0.1:5992;spaces 集成测试 22/22(真实 PG)通过
- host-core 迁移 v21(`channel_accounts`)+ v20→v21 迁移链修复(chained if 19 后补 20→21)
- Docker daemon 未运行，WeKnora 实例(AC-05)无法启动

## 验证终态

desktop 3563/0 · host-core 701/701 · server 209/209(真实 PG)· typecheck/build:js 干净。
