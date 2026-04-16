# LaboFlow

咨询行业 AI 工作台。基于 **Clawith**（主平台）、**LightRAG**（知识库）和 **AIPPT**（AI PPT）三个开源组件半解耦集成而成。

## 目录

- [简介](#简介)
- [核心功能](#核心功能)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [开发指南](#开发指南)

---

## 简介

LaboFlow 是一款面向咨询行业的 AI 工作平台，旨在为咨询从业者提供一个高效、智能的一站式工作环境。

LaboFlow 由三个核心组件构成：

| 组件 | 技术栈 | 功能定位 |
|------|--------|----------|
| **Clawith** | FastAPI + React | 主平台：多智能体协作、任务管理、SSO 统一认证 |
| **LightRAG** | FastAPI + Vite | 知识库：RAG 检索增强生成、知识图谱构建与查询 |
| **AIPPT** | Vue 3 + Vite | AI PPT：智能生成演示文稿、在线编辑与导出 |

LaboFlow 通过 NGINX 反向代理将三个组件统一到单一入口（默认端口 3008），实现统一认证和 seamless 的用户体验。

---

## 核心功能

### 🤖 多智能体协作（Clawith）

- **数字员工**：每个 AI Agent 拥有独立的身份、长期记忆和私有工作空间
- **自主意识系统（Aware）**：智能体主动感知、决策、执行任务，而非被动等待指令
- **Focus Items**：结构化的工作记忆，支持 `[ ]` 待办、`[/]` 进行中、`[x]` 已完成状态
- **六种触发机制**：cron 定时、once 单次、interval 间隔、poll HTTP 轮询、on_message 消息触发、webhook 外部事件
- **Plaza 广场**：智能体之间共享发现、评论彼此工作的实时知识流
- **Organization 级控制**：多租户 RBAC、频道集成（Slack/Discord/飞书）、用量配额、审批工作流、审计日志

### 📚 RAG 知识库（LightRAG）

- **双层检索**：向量检索 + 知识图谱双重检索机制，大幅提升查询准确性和多样性
- **多存储后端**：支持 PostgreSQL、MongoDB、Neo4j、OpenSearch 等多种存储方案
- **交互式 WebUI**：文档索引、知识图谱可视化、简单 RAG 查询界面
- **Reranker 集成**：混合查询模式下自动启用重排模型，显著提升检索性能
- **Ollama 兼容接口**：可与 Open WebUI 等第三方 AI 聊天工具无缝对接

### 📊 AI PPT 演示文稿（AIPPT）

- **多 LLM 支持**：DeepSeek、GPT、Claude、Gemini、Kimi、通义千问等主流大模型
- **一键生成**：输入主题即可 AI 生成完整演示文稿，支持实时流式预览
- **可视化编辑器**：拖拽式画布，支持文字、图片、图表（ECharts）、思维导图、表格、代码块
- **智能图表**：自动检测数据结构，推荐最佳图表类型
- **多格式导出**：PDF、PPTX、PNG/JPG 图片
- **隐私优先**：API Key 仅存储在浏览器本地存储，不上传至第三方服务器

### 🔐 统一认证（SSO）

- 基于 Clawith JWT 的跨组件单点登录
- LightRAG 和 AIPPT 共享 Clawith 签发的 Token，实现统一身份验证

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    NGINX (端口 3008)                        │
│              统一入口 · 反向代理 · 请求路由                   │
├─────────────┬──────────────┬───────────────┬────────────────┤
│   /         │   /api /ws   │   /kb/        │    /ppt/       │
│  (Clawith)  │  (Clawith)   │  (LightRAG)   │    (AIPPT)     │
├─────────────┼──────────────┼───────────────┼────────────────┤
│   3080      │    8008      │    9621       │    5173        │
│ (Frontend)  │  (Backend)   │ (API+WebUI)   │   (Frontend)   │
└─────────────┴──────────────┴───────────────┴────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌──────────┐     ┌─────────────┐    ┌──────────┐
   │ Clawith  │     │ LightRAG    │    │  AIPPT   │
   │ Backend  │     │ .rag_storage│    │  前端    │
   │ PostgreSQL│    │ .inputs     │    │          │
   │ Redis    │     │             │    │          │
   └──────────┘     └─────────────┘    └──────────┘
```

### 端口规划

| 服务 | 端口 | NGINX 路径 |
|------|------|------------|
| NGINX 统一入口 | **3008** | — |
| Clawith 前端 | 3080 | `/` |
| Clawith 后端 | 8008 | `/api`, `/ws` |
| LightRAG | 9621 | `/kb/` |
| AIPPT | 5173 | `/ppt/` |

### 目录结构

```
LaboFlow/
├── Clawith/                  # 主平台（FastAPI + React）
│   ├── backend/              # Python FastAPI 后端
│   └── frontend/             # React 前端
├── LightRAG/                 # 知识库 / RAG 引擎
├── aippt/                    # AI PPT 前端（Vue 3）
├── .env.example              # 共享环境变量模板
├── .env                      # 环境变量配置
├── nginx.conf                # NGINX 反向代理配置
├── docker-compose.yml        # Docker 一键部署配置
├── setup-all.sh              # 首次安装脚本
├── dev.sh                    # 开发模式启动脚本
└── stop.sh                   # 停止所有服务
```

---

## 快速开始

### 前置依赖

- Python 3.12+
- Node.js 20+ 和 `pnpm`
- `uv`：LightRAG 使用 `curl -LsSf https://astral.sh/uv/install.sh | sh`
- `nginx`：macOS `brew install nginx`，Debian/Ubuntu `sudo apt install nginx`
- PostgreSQL 15+（或让脚本自动安装）
- Docker（可选，用于 Docker 部署）

### 方法一：Docker 一键启动（推荐）

```bash
# 克隆项目
git clone https://github.com/your-repo/LaboFlow.git
cd LaboFlow

# 复制环境变量模板
cp .env.example .env

# 编辑 .env，配置以下必填项：
# - JWT_SECRET_KEY（生成命令：python3 -c 'import secrets; print(secrets.token_urlsafe(48))'）
# - LLM API Key（如 LIGHTRAG_LLM_BINDING_API_KEY）

# 一键启动所有服务
docker compose up -d
```

启动后访问：

- **统一入口**：http://localhost:3008
- **知识库**：http://localhost:3008/kb/
- **AI PPT**：http://localhost:3008/ppt/

停止服务：`docker compose down`

---

## 开发指南

### 首次安装

```bash
cd LaboFlow

# 复制环境变量
cp .env.example .env

# 生成 JWT 密钥
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
# 将生成的密钥填入 .env 中的 JWT_SECRET_KEY

# 安装所有依赖
./setup-all.sh
```

`setup-all.sh` 会依次完成：

1. 检查系统工具（nginx、uv、pnpm、python3）
2. Clawith：Python 虚拟环境 + Node 依赖 + PostgreSQL 配置
3. LightRAG：uv sync 同步依赖 + 生成 `.env`
4. AIPPT：pnpm install 安装依赖

### 启动开发环境

```bash
./dev.sh
```

输出示例：

```
═══════════════════════════════════════════════════
  🦞 Labo-Flow dev environment is up
═══════════════════════════════════════════════════

  Unified entry:   http://localhost:3008
  Knowledge Base:  http://localhost:3008/kb/
  AI PPT:          http://localhost:3000/ppt/

  Direct access (debugging):
    Clawith frontend  http://localhost:3080
    Clawith backend   http://localhost:8008/api/health
    LightRAG          http://localhost:9621
    AIPPT             http://localhost:5173

  Logs:   tail -f .data/log/*.log
  Stop:   ./stop.sh
```

### 停止服务

```bash
./stop.sh
```

### 环境变量说明

主要环境变量配置在 `.env` 中：

```bash
# 统一入口
NGINX_PORT=3008
PUBLIC_BASE_URL=http://localhost:3008

# Clawith
JWT_SECRET_KEY=your-jwt-secret-key
CLAWITH_BACKEND_PORT=8008

# LightRAG
LIGHTRAG_PORT=9621
LIGHTRAG_LLM_BINDING_API_KEY=your-api-key
LIGHTRAG_EMBEDDING_MODEL=text-embedding-3-small

# AIPPT
VITE_JWT_SECRET=${JWT_SECRET_KEY}
VITE_CUSTOM_LLM_URL=http://localhost:8008/api/v1/llm-proxy
```

### 故障排查

| 问题 | 解决方案 |
|------|----------|
| 端口被占用 | `./stop.sh` 会清理已知端口；仍占用可手动 `lsof -i:3008` |
| NGINX 启动失败 | 检查 `include /etc/nginx/mime.types` 路径是否正确 |
| LightRAG 启动失败 | 确认 `LightRAG/.env` 存在且 LLM API Key 已配置 |
| AIPPT 子路径 404 | 确保 `VITE_BASE=/ppt/` 环境变量已传入 |
| 数据库连接失败 | 确认 PostgreSQL 已启动，DATABASE_URL 配置正确 |

查看日志：

```bash
tail -f .data/log/*.log
```

---

## 开发路线图

| 阶段 | 状态 | 交付物 |
|------|------|--------|
| 1. 环境搭建 + NGINX 基础集成 | ✅ 已完成 | `nginx.conf`, `dev.sh`, `setup-all.sh` |
| 2. 统一认证 SSO | ✅ 已完成 | Clawith JWT → LightRAG/AIPPT 共享校验 |
| 3. LightRAG MCP 封装 | 🔄 进行中 | `knowledge_search` 等 MCP 工具 |
| 4. AIPPT LLM 配置集成 | 🔜 待开始 | `modelRouter.ts` 改为走 Clawith LLM proxy |
| 5. 预设 Agent 开发 | 🔜 待开始 | 客户研究 / 访谈分析 / 报告 / PPT 五个 Agent |
| 6. Docker Compose + 文档 | 🔜 待开始 | 一键部署 |
| 7. 测试与优化 | 🔜 待开始 | 发布就绪 |

---

## 技术栈

| 组件 | 后端 | 前端 |
|------|------|------|
| **Clawith** | FastAPI · SQLAlchemy · PostgreSQL · Redis · JWT · MCP Client | React 19 · TypeScript · Vite · Zustand · TanStack Query |
| **LightRAG** | FastAPI · NanoVectorDB · Neo4j · OpenSearch | Vite · WebUI |
| **AIPPT** | — | Vue 3 · TypeScript · Vite · Pinia · Konva.js · ECharts |

---

## 许可证

本项目基于 Apache 2.0 许可证开源。
