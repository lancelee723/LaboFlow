# 改造清单 01：品牌替换（Stage 1，已完成）

- 日期：2026-09-09
- 基点：PI-Desktop `v0.14.5`（commit `cc61697a`）

## 已替换（用户可见 / 身份面）

| 位置 | 变更 |
|---|---|
| `packages/shared/src/protocol.ts` | `APP_ID` → `com.laboflow.app`；`APP_NAME` → `LaboFlow`（驱动 `app.setName` → userData 目录 `~/Library/Application Support/LaboFlow`、单实例锁、窗口标题） |
| `apps/desktop/electron/main/updater.ts` | `RELEASES_URL` 重定向 `vastsa/PI-Desktop` → `lancelee723/laboflow`（**关键项**：否则应用会提示装回上游包） |
| `packages/shared/src/github-feedback.ts` | `GITHUB_REPO` → `lancelee723/laboflow`；反馈正文品牌串 |
| `apps/desktop/package.json` | `appId`/`productName`/`publish`(owner→lancelee723, repo→laboflow)/`win.executableName`→LaboFlow/`nsis.shortcutName`+`artifactName`→LaboFlow-Setup-…/`deb.packageName`→laboflow/`linux.executableName`→laboflow/dmg 帮助文件名/`description`/`homepage`/`author`→LaboFlow Team |
| `package.json`（根） | name → `laboflow`；description 注明 fork 来源 |
| `scripts/dev-electron.mjs` | dev bundle id → `com.laboflow.app.dev` |
| `apps/desktop/index.html` | `<title>` → LaboFlow |
| `packages/i18n/src/locales/*/index.ts`（8 语言，128 处） | 品牌串 `PI-Desktop` → `LaboFlow`（含 shellName、托盘、退出确认、输入框占位等） |
| `packages/shared/src/changelog*.ts`（8 语言） | 应用内更新日志品牌串 |
| `packages/agent-runtime/src/*` | **Agent 系统提示词身份**（`You are LaboFlow…`）、子代理提示、项目说明注入语 |
| `packages/plugin-devkit/src/*` | CLI usage、插件模板、校验提示 |
| `apps/desktop/src/`（App/SettingsPage/ProviderHeadersEditor） | 默认请求头 X-Client-Name/X-Title、版本回退名等 |
| `apps/desktop/electron/main/{builtin-skills,plugin-mcp}.ts` | 内置技能回退名、MCP clientInfo |
| 图标 | LaboFlow Logo SVG → `build/icon_1024.png`（rsvg-convert）→ `scripts/make-icon.py` 派生 `icon.icns`/`icon.png`/`tray-icon-mac.png`；渲染层 `src/assets/brand/logo-{light,dark}.png`（256px，暗色版反色） |
| `apps/desktop/LaboFlow-macOS-opening-help.txt` | 由 PI-Desktop 版重写（dmg 内用户可见） |
| 品牌一致性测试 | `development-branding` / `auto-update` / `renderer-branding` 三个测试断言同步改为 LaboFlow，反向守护新品牌 |

## 明确保留（Stage 2 候选，均为内部标识）

| 项 | 现状 | 说明 |
|---|---|---|
| npm scope `@pi-desktop/*` | 保留 | 全仓 import 路径与 workspace 包名，机械替换量大且无用户价值；如做，用脚本一次替换 + 全量测试 |
| Rust 二进制 `pi-desktop-host-core` | 保留 | `crates/host-core` 包名与打包路径；内部名，改名需同步 electron-builder 配置与 3 处 extraResources |
| IPC 通道前缀 `pi-desktop/...` | 保留 | `protocol.ts` 通道注册表 + `window-menu.test.mjs` 断言；协议版本 v11，改名等于破坏性协议变更 |
| 环境变量 `PI_DESKTOP_DEV` | 保留 | dev 脚本内部开关 |
| 文档站 `docs/`（363 md）与 `docs/spec` 基线 | 保留原文 | 上游规格文档，作为架构参考；本地化改写按需进行 |
| `.github/workflows` | 保留 | release.yml 推到新远端后自然适配；签名凭据未配置 |
| 上游文档站外链（pi-docs.aiuo.net） | 保留 | 应用内帮助入口短期仍指上游文档，功能等价 |
| 版本号 0.14.5 | 保留 | 与上游基点对齐，便于 cherry-pick 对账；发版节奏自定后可另起版本线 |

## 验证方式

`pnpm typecheck && pnpm lint && pnpm test`（品牌测试在内）+ `pnpm dev` 启动后 Dock 图标/窗口标题/托盘菜单均为 LaboFlow。
