# LaboFlow

咨询行业 AI 工作台。基于 **Clawith**（主平台）、**WeKnora**（知识库）和 **AIPPT**（AI PPT）三个开源组件半解耦集成而成。

## 目录

- [简介](#简介)
- [核心功能](#核心功能)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [开发指南](#开发指南)
- [WeKnora 集成说明](#weknora-集成说明)

---

## 简介

LaboFlow 是一款面向咨询行业的 AI 工作平台，旨在为咨询从业者提供一个高效、智能的一站式工作环境。

LaboFlow 由三个核心组件构成：

| 组件 | 技术栈 | 功能定位 |
|------|--------|----------|
| **Clawith** | FastAPI + React | 主平台：多智能体协作、任务管理、SSO 统一认证 |
| **WeKnora** | Go + Vue 3 | 知识库：RAG 检索增强生成、文档解析与向量检索 |
| **AIPPT** | Vue 3 + Vite | AI PPT：智能生成演示文稿、在线编辑与导出 |

LaboFlow 通过 NGINX 反向代理将三个组件统一到单一入口（默认端口 3008），实现统一认证和无缝的用户体验。

---

## 核心功能

### Clawith 主平台

- **多智能体协作**：支持自定义 Agent 工作流，集成 MCP 工具生态
- **任务管理**：结构化项目与任务跟踪
- **统一认证**：基于 JWT 的 SSO，所有子系统免二次登录

### WeKnora 知识库

- **文档解析**：支持 PDF、Word、PPT、Excel 等格式的深度解析
- **向量检索**：支持 PostgreSQL (pgvector)、Qdrant、Milvus、Elasticsearch 等多种向量存储
- **知识图谱**：GraphRAG 支持实体关系提取与图谱查询（可选 Neo4j）
- **智能问答**：基于 Agent 的知识问答，支持多轮对话

### AIPPT

- **智能图表**：自动检测数据结构，推荐最佳图表类型
- **多格式导出**：PDF、PPTX、PNG/JPG 图片
- **隐私优先**：API Key 仅存储在浏览器本地存储

### 统一认证（SSO）

- 基于 Clawith JWT 的跨组件单点登录
- WeKnora 和 AIPPT 共享 Clawith 签发的 Token，实现统一身份验证

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    NGINX (端口 3008)                        │
│              统一入口 · 反向代理 · 请求路由                   │
├─────────────┬──────────────┬───────────────┬────────────────┤
│   /         │   /api /ws   │   /kb/        │    /ppt/       │
│  (Clawith)  │  (Clawith)   │  (WeKnora)    │    (AIPPT)     │
├─────────────┼──────────────┼───────────────┼────────────────┤
│   3080      │    8008      │    8800       │    5173        │
│ (Frontend)  │  (Backend)   │ (Web+API)     │   (Frontend)   │
└─────────────┴──────────────┴───────────────┴────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌──────────┐     ┌─────────────┐    ┌──────────┐
   │ Clawith  │     │  WeKnora    │    │  AIPPT   │
   │ Backend  │     │  App (Go)   │    │  前端    │
   │ PostgreSQL│    │  PostgreSQL │    │          │
   │ Redis    │     │  Redis      │    │          │
   └──────────┘     │  DocReader  │    └──────────┘
                    └─────────────┘
```

### 端口规划

| 服务 | 端口 | NGINX 路径 |
|------|------|------------|
| NGINX 统一入口 | **3008** | — |
| Clawith 前端 | 3080 | `/` |
| Clawith 后端 | 8008 | `/api`, `/ws` |
| WeKnora 前端 + API | 8800 | `/kb/` |
| AIPPT | 5173 | `/ppt/` |

### 目录结构

```
LaboFlow/
├── Clawith/                  # 主平台（FastAPI + React）
│   ├── backend/              # Python FastAPI 后端
│   └── frontend/             # React 前端
├── WeKnora/                  # 知识库（Go + Vue 3）
│   ├── internal/             # Go 后端
│   ├── frontend/             # Vue 3 前端
│   └── docker-compose.yml    # WeKnora Docker 编排
├── aippt/                    # AI PPT 前端（Vue 3）
├── .env.example              # 共享环境变量模板
├── .env                      # 环境变量配置（本地，不提交）
├── nginx.conf                # NGINX 反向代理配置（开发）
├── nginx/docker.conf         # NGINX 反向代理配置（生产）
├── docker-compose.yml        # Docker 一键部署配置
├── dev.sh                    # 开发模式启动脚本
└── stop.sh                   # 停止所有服务
```

---

## 快速开始

### 前置依赖

- Python 3.12+
- Node.js 20+
- Go 1.23+ (WeKnora)
- `uv`：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- `nginx`：macOS `brew install nginx`，Debian/Ubuntu `sudo apt install nginx`
- Docker & Docker Compose（WeKnora 依赖服务通过 Docker 运行）

### 方法一：Docker 一键启动（推荐）

```bash
# 克隆项目
git clone https://github.com/lancelee723/LaboFlow.git
cd LaboFlow

# 复制环境变量模板
cp .env.example .env
cp WeKnora/.env.example WeKnora/.env

# 编辑 .env，配置以下必填项：
# - JWT_SECRET_KEY（生成命令：python3 -c 'import secrets; print(secrets.token_urlsafe(48))'）
# - WeKnora/.env 中的 JWT_SECRET 必须与 JWT_SECRET_KEY 相同

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

# 生成 JWT 密钥并填入 .env
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
# JWT_SECRET_KEY=<生成的密钥>

# 安装所有依赖
./setup-all.sh
```

### 启动开发环境

```bash
./dev.sh
```

启动成功后：

```
═══════════════════════════════════════════════════
  Labo-Flow dev environment is up
═══════════════════════════════════════════════════

  Unified entry:   http://localhost:3008
  Knowledge Base:  http://localhost:3008/kb/
  AI PPT:          http://localhost:3008/ppt/

  Direct access (debugging):
    Clawith frontend  http://localhost:3080
    Clawith backend   http://localhost:8008/api/health
    WeKnora           http://localhost:8800
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

# WeKnora
WEKNORA_URL=/kb
WEKNORA_FRONTEND_PORT=8800

# WeKnora SSO（WeKnora/.env 中的 JWT_SECRET 必须与 JWT_SECRET_KEY 相同）
```

### 故障排查

| 问题 | 解决方案 |
|------|----------|
| 端口被占用 | `./stop.sh` 会清理已知端口；仍占用可手动 `lsof -i:3008` |
| NGINX 启动失败 | 检查 `include /etc/nginx/mime.types` 路径是否正确 |
| WeKnora 文档解析失败 | 确认 DocReader 已启动：`docker compose ps docreader` |
| WeKnora 知识库不可用 | 确认向量存储引擎（默认 pgvector）已就绪 |
| 数据库连接失败 | 确认 Docker 依赖服务已启动：`docker compose up -d postgres` |
| SSO 登录失败 | 确认 JWT_SECRET_KEY 与 WeKnora/.env 中的 JWT_SECRET 一致 |

查看日志：

```bash
tail -f .data/log/*.log
```

---

## WeKnora 集成说明

> **重要**：WeKnora 是腾讯开源的 RAG 知识库框架。LaboFlow 集成了 WeKnora 并在其基础上做了**少量定制**。

### 定制文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `WeKnora/frontend/vite.config.ts` | 修改 | 新增 `base` 配置支持 `VITE_BASE_URL` 环境变量 |
| `WeKnora/frontend/Dockerfile.laboflow` | 新增文件 | LaboFlow 专用构建，以 `/kb/` 为基础路径 |
| `WeKnora/frontend/src/views/auth/SSO.vue` | 新增文件 | SSO 落地页，提取 URL 中的 token 并向后端换取 WeKnora session |
| `WeKnora/internal/handler/auth.go` | 新增代码 | 新增 `SSOClawithLogin` handler，验证 Clawith JWT 并自动注册用户 |
| `WeKnora/internal/application/service/user.go` | 新增代码 | 新增 `LoginWithSSO` 方法，自动创建用户和租户 |
| `WeKnora/internal/middleware/auth.go` | 修改 | 将 `/api/v1/auth/sso/clawith` 加入无需认证路径列表 |
| `WeKnora/internal/router/router.go` | 修改 | 注册 SSO 路由 |

### SSO 工作原理

```
Clawith 用户点击「知识库」
        │
        ▼
GET /api/enterprise/weknora/sso-token   ← Clawith 后端签发 5 分钟 JWT
        │  { sub, email, role, aud:"weknora", exp }
        │  签名密钥：JWT_SECRET_KEY
        ▼
window.open("{weknora_url}/sso?token=JWT")
        │
        ▼
WeKnora /sso 页面（新增文件）
        │  提取 token，POST 到后端
        ▼
POST /api/v1/auth/sso/clawith           ← WeKnora 后端（新增 endpoint）
        │  验证签名（JWT_SECRET）
        │  自动注册或登录用户
        ▼
WeKnora access token → localStorage → 跳转 /kb/platform/knowledge-bases
```

### 升级 WeKnora 时的注意事项

1. `vite.config.ts` 中的 `base` 配置可能需要合并
2. `auth.go` 和 `user.go` 中新增的方法位于文件末尾，通常不会产生 conflict
3. `SSO.vue` 是全新文件，不会 conflict
4. 升级后运行 `git diff HEAD WeKnora/` 检查是否有冲突

### MinerU 文档解析器（可选）

WeKnora 内置的 DocReader 可处理常见文档格式。如需更高解析质量，可启用 MinerU：

```bash
# 启动 MinerU 服务
docker compose --profile mineru up -d mineru

# 在 WeKnora/.env 中配置
MINERU_ENDPOINT=http://mineru:9930
```

---

## 技术栈

| 组件 | 后端 | 前端 |
|------|------|------|
| **Clawith** | FastAPI · SQLAlchemy · PostgreSQL · Redis · JWT · MCP Client | React 19 · TypeScript · Vite · Zustand · TanStack Query |
| **WeKnora** | Go · Gin · GORM · PostgreSQL (pgvector) · Redis · JWT | Vue 3 · TypeScript · Vite · Pinia |
| **AIPPT** | — | Vue 3 · TypeScript · Vite · Pinia · Konva.js · ECharts |

---

## 许可证

本项目基于 Apache 2.0 许可证开源。
