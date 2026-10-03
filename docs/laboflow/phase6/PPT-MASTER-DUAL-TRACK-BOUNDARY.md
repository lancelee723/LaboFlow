# PPT-Master 双轨边界：LaboFlow 插件 vs WebUI 服务端

| 文档属性 | 内容 |
|---|---|
| 日期 | 2026-10-03 |
| 范围 | 明确 `/Users/lance/LaboFlow`（PPT-Master WebUI 集成线）与 `/Users/lance/LaboFlow Desktop`（桌面插件线）的分工、共享与回流规则 |

## 1. 两条线的定位

| | 桌面插件（laboflow.slides） | WebUI 服务端（LaboFlow repo） |
|---|---|---|
| 形态 | PI-Desktop bundled 插件：会话内 Agent 驱动 vendored 管线 | 独立 Web 服务：浏览器向导式批量生成 |
| 确认面 | chat 确认 + 确认卡/工作台（pipeline-state 硬门禁） | WebUI 表单向导（服务端状态） |
| 引擎 | vendored ppt-master（AGPL 裁剪集，guard 封禁） | 服务端 Python 环境（独立管理依赖） |
| 用户 | LaboFlow 桌面单机/组织成员 | Web 浏览器场景 |
| 变更节奏 | 跟随上游 re-vendor（pin + 快照测试守护） | 跟随上游 pull（merge-weknora 式合并） |

## 2. 共享原则

1. **vendored 底座不共享**：插件线 vendored/ppt-master 由 `VENDOR_VERSION` 钉定并裁剪；WebUI 线用自己 checkout 的上游。两边各自升级，不做符号链接/共享目录（部署形态不同：插件随 app 包分发）。
2. **裁剪与许可规则一致**：两边都不得引入 PyMuPDF/edge-tts/ebooklib（AGPL/GPL）——WebUI 线的依赖审计用同一份黑名单（见插件 `lib/ppt-runtime.js` FORBIDDEN_DISTRIBUTIONS）。
3. **上游通用修复回流 upstream**：任何一边发现的上游 bug 修复（如 v6.6.0 checker 的 roster 一致性契约适配），优先给 hugohe3/ppt-master 提 PR，而不是只在本地一份改。LaboFlow 专属适配（guard、--dir 强制、PYTHONDONTWRITEBYTECODE）不回流。

## 3. 漂移监控

- 每次上游发 tag（当前 v6.6.0）跑一次 VENDOR_README「漂移核查」：requirements diff + 白名单 CLI 面 diff + 评估增值。
- WebUI 线升级上游时若**先于**插件线吃进上游变化，把新契约点（如新的 checker 强制项）同步到插件线的 PPT_IT 场景剧本，避免两边对同一上游版本的认知分叉。
