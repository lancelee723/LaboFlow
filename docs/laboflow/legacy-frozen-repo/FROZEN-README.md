# LaboFlow README

为管理咨询团队定制的 AI 工作台。以开源 Pi Agent（MIT）为内核的跨平台桌面端（Windows x64 / macOS arm64 / Linux x64）+ 私有化 Docker 服务端（规划中，P2）。

- 产品文档：`docs/PRD-LaboFlow-v1.0.md`（v1.1）、`docs/SPEC-LaboFlow-v1.0.md`（v1.1）、`docs/PLAN-LaboFlow-v1.0.md`（v1.1）
- 架构决策：`docs/adr/`
- 当前阶段：**P0 架构地基（已完成，见 `docs/P0验收报告.md`）**

## 快速开始

```bash
pnpm install          # 安装全部工作区依赖（首次会下载 Electron 二进制）
pnpm dev              # 本地开发模式：直接启动桌面端，无需安装包
pnpm test             # 全工作区单测
pnpm lint             # ESLint
pnpm typecheck        # TS 严格检查
pnpm spike            # Pi 引擎集成 Spike（headless 端到端验证）
pnpm package          # 打包当前平台安装包（mac dmg / win nsis / linux deb+AppImage）
```

### 本地开发模式（推荐日常测试方式）

`pnpm dev` 一条命令启动完整应用：主进程构建 → Vite 热更新服务（:5173）→ Electron 窗口。
渲染层改动保存即生效；主进程改动重新运行 `pnpm dev` 即可。启动时自动清理残留端口。

- **无需 API Key**：Pi 引擎内嵌 + 本地 mock 模型端到端可用（真实渠道在 ⚙ 设置→模型渠道里填 Key）
- **数据隔离**：默认数据在用户数据目录；用 `LABOFLOW_DATA_DIR=/some/dir pnpm dev` 开独立沙盒
- **Headless 验证**：`LABOFLOW_E2E=1`（权限/计划/持久化三层自动断言）或 `pnpm spike`（引擎层）
- 打包版（dmg/exe/deb）仅用于发布验收，日常测试一律用 `pnpm dev`

## 结构

```
apps/desktop    Electron 客户端（main = LaboFlow Core；renderer = React UI）
apps/server     服务端骨架（NestJS 实施在 P2）
packages/shared IPC 契约 / 事件模型 / 快捷键表（三端共享）
packages/ui     设计 token
packages/tsconfig 共享 TS 配置
```

## 说明

- Pi 引擎（`@earendil-works/pi-coding-agent`，锁定 0.85.0）内嵌于主进程，状态隔离在 `userData/pi`；P0 使用本地 mock OpenAI 兼容服务演示端到端链路，无需任何 API Key。
- 上游缺失依赖通过根 `package.json` 的 `pnpm.packageExtensions` 修补（见 ADR-001），升级 Pi 时需复查。

---

> **⚠️ 仓库已冻结（2026-09-09）**：本项目已冻结归档。产品转向：以 PI-Desktop v0.14.5（LGPL-3.0）硬 fork 为新核心，品牌更名 LaboFlow，嫁接本仓库的团队/组织能力（服务端 `apps/server` 与管理台 `apps/admin-console` 代码仍然有效，后续迁入新仓库对接）。新仓库：`/Users/lance/laboflow`。决策记录见新仓库 `docs/laboflow/00-pivot-decision.md`。本仓库仅作历史参考与资产库，不再开发。
