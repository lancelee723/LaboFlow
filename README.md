# Labo-Flow

咨询行业 AI 工作台。基于 **Clawith**（主平台）、**LightRAG**（知识库）和 **AIPPT**（AI PPT）三个开源组件半解耦集成而成。

详细方案见 [`Labo-Flow开发方案（Clawith版）.md`](./Labo-Flow开发方案（Clawith版）.md)。

## 仓库结构

```
LaboFlow/
├── Clawith/                  # 主平台（FastAPI + React）
├── LightRAG/                 # 知识库 / RAG 引擎（FastAPI + Vite WebUI）
├── aippt/                    # AI PPT 前端（Vue 3 + Vite）
├── .env.example              # 共享环境变量模板（含 JWT 密钥）
├── nginx.conf                # 统一入口反向代理配置（端口 3008）
├── setup-all.sh              # 一次性安装脚本（调用各子项目的 setup）
├── dev.sh                    # 开发模式启动脚本（四服务 + NGINX）
├── stop.sh                   # 停止所有服务
└── Labo-Flow开发方案（Clawith版）.md   # 产品与架构方案书
```

## 端口规划

| 服务 | 端口 | NGINX 路径 |
|---|---|---|
| NGINX 统一入口 | **3008** | — |
| Clawith frontend | 3080 | `/` |
| Clawith backend | 8008 | `/api`, `/ws` |
| LightRAG | 9621 | `/kb/` |
| AIPPT | 5173 | `/ppt/` |

> 注意：Clawith 原默认前端端口为 3008，这里移至 3080 把 3008 让给 NGINX。

## 快速开始

**前置依赖**（请先在系统中安装）：
- Python 3.12+
- Node.js 20+ 和 `pnpm`
- `uv`（LightRAG 使用）：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- `nginx`：macOS `brew install nginx`，Debian/Ubuntu `sudo apt install nginx`
- PostgreSQL 15+（或让 Clawith 的 setup.sh 自动安装）

**首次安装：**

```bash
cp .env.example .env
# 编辑 .env，生成 JWT_SECRET_KEY 并填入 LLM API Key
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'

./setup-all.sh        # 安装各子项目依赖（幂等）
```

**启动开发环境：**

```bash
./dev.sh              # 启动 Clawith + LightRAG + AIPPT + NGINX
# 浏览器访问 http://localhost:3008
# 知识库   http://localhost:3008/kb/
# AI PPT   http://localhost:3008/ppt/

./stop.sh             # 停止所有服务
```

日志在 `.data/log/`，PID 在 `.data/pid/`。

## 开发路线图

对应方案书第四章的 7 个阶段：

| 阶段 | 状态 | 交付物 |
|---|---|---|
| 1. 环境搭建 + NGINX 基础集成 | **已完成** | `nginx.conf`, `dev.sh`, `setup-all.sh` |
| 2. 统一认证 SSO | **已完成** | Clawith JWT → LightRAG/AIPPT 共享校验 |
| 3. LightRAG MCP 封装 | 待开始 | `knowledge_search` 等 MCP 工具 |
| 4. AIPPT LLM 配置集成 | 待开始 | `modelRouter.ts` 改为走 Clawith LLM proxy |
| 5. 预设 Agent 开发 | 待开始 | 客户研究 / 访谈分析 / 报告 / PPT 五个 Agent |
| 6. Docker Compose + 文档 | 待开始 | 一键部署 |
| 7. 测试与优化 | 待开始 | 发布就绪 |

## 故障排查

- **端口被占用**：`./stop.sh` 会清理已知端口；仍占用可手动 `lsof -i:3008`。
- **NGINX 启动失败**：检查 `include /etc/nginx/mime.types;` — 如果系统 nginx 不在默认路径，调整 `nginx.conf` 顶部的 include 路径。
- **LightRAG 启动失败**：先确认 `LightRAG/.env` 存在且 LLM binding 相关密钥已设置。首次运行需下载 embedding 模型。
- **AIPPT 子路径 404**：Vite 的 `base` 必须为 `/ppt/`。本项目通过 `VITE_BASE=/ppt/` 环境变量传入，AIPPT 侧需在 `vite.config.js` 读取该变量（Phase 1 后期任务）。
