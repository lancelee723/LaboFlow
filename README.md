# LaboFlow

咨询行业 AI 工作台。基于 **Clawith**（主平台）、**RAGFlow**（知识库）和 **AIPPT**（AI PPT）三个开源组件半解耦集成而成。

## 目录

- [简介](#简介)
- [核心功能](#核心功能)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [开发指南](#开发指南)
- [RAGFlow 定制说明](#ragflow-定制说明)

---

## 简介

LaboFlow 是一款面向咨询行业的 AI 工作平台，旨在为咨询从业者提供一个高效、智能的一站式工作环境。

LaboFlow 由三个核心组件构成：

| 组件 | 技术栈 | 功能定位 |
|------|--------|----------|
| **Clawith** | FastAPI + React | 主平台：多智能体协作、任务管理、SSO 统一认证 |
| **RAGFlow** | Python + React | 知识库：RAG 检索增强生成、文档解析与向量检索 |
| **AIPPT** | Vue 3 + Vite | AI PPT：智能生成演示文稿、在线编辑与导出 |

LaboFlow 通过 NGINX 反向代理将三个组件统一到单一入口（默认端口 3008），实现统一认证和无缝的用户体验。

---

## 核心功能

### 🤖 Clawith 主平台

- **多智能体协作**：支持自定义 Agent 工作流，集成 MCP 工具生态
- **任务管理**：结构化项目与任务跟踪
- **统一认证**：基于 JWT 的 SSO，所有子系统免二次登录

### 📚 RAGFlow 知识库

- **文档解析**：支持 PDF、Word、PPT、Excel 等格式的深度解析
- **向量检索**：基于 Elasticsearch 的语义搜索
- **知识图谱**：GraphRAG 支持实体关系提取与图谱查询

### 📊 AIPPT

- **智能图表**：自动检测数据结构，推荐最佳图表类型
- **多格式导出**：PDF、PPTX、PNG/JPG 图片
- **隐私优先**：API Key 仅存储在浏览器本地存储

### 🔐 统一认证（SSO）

- 基于 Clawith JWT 的跨组件单点登录
- RAGFlow 和 AIPPT 共享 Clawith 签发的 Token，实现统一身份验证

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    NGINX (端口 3008)                        │
│              统一入口 · 反向代理 · 请求路由                   │
├─────────────┬──────────────┬───────────────┬────────────────┤
│   /         │   /api /ws   │   /rag/       │    /ppt/       │
│  (Clawith)  │  (Clawith)   │  (RAGFlow)    │    (AIPPT)     │
├─────────────┼──────────────┼───────────────┼────────────────┤
│   3080      │    8008      │    8880       │    5173        │
│ (Frontend)  │  (Backend)   │ (Web+API)     │   (Frontend)   │
└─────────────┴──────────────┴───────────────┴────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                  ▼
   ┌──────────┐     ┌─────────────┐    ┌──────────┐
   │ Clawith  │     │  RAGFlow    │    │  AIPPT   │
   │ Backend  │     │  MySQL      │    │  前端    │
   │ PostgreSQL│    │  Redis      │    │          │
   │ Redis    │     │  MinIO      │    │          │
   └──────────┘     │  ES         │    └──────────┘
                    └─────────────┘
```

### 端口规划

| 服务 | 端口 | NGINX 路径 |
|------|------|------------|
| NGINX 统一入口 | **3008** | — |
| Clawith 前端 | 3080 | `/` |
| Clawith 后端 | 8008 | `/api`, `/ws` |
| RAGFlow Web + API | 8880 | `/rag/` |
| AIPPT | 5173 | `/ppt/` |

### 目录结构

```
LaboFlow/
├── Clawith/                  # 主平台（FastAPI + React）
│   ├── backend/              # Python FastAPI 后端
│   └── frontend/             # React 前端
├── ragflow/                  # 知识库（RAGFlow，git submodule）
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
- `uv`：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- `nginx`：macOS `brew install nginx`，Debian/Ubuntu `sudo apt install nginx`
- Docker & Docker Compose（RAGFlow 依赖服务通过 Docker 运行）

### 方法一：Docker 一键启动（推荐）

```bash
# 克隆项目（含子模块）
git clone --recurse-submodules https://github.com/lancelee723/LaboFlow.git
cd LaboFlow

# 复制环境变量模板
cp .env.example .env

# 编辑 .env，配置以下必填项：
# - JWT_SECRET_KEY（生成命令：python3 -c 'import secrets; print(secrets.token_urlsafe(48))'）
# - CLAWITH_JWT_SECRET_KEY（必须与 JWT_SECRET_KEY 相同）

# 一键启动所有服务
docker compose up -d
```

启动后访问：

- **统一入口**：http://localhost:3008
- **知识库**：http://localhost:3008/rag/
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
# CLAWITH_JWT_SECRET_KEY=<同上，必须与 JWT_SECRET_KEY 相同>

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
  🦞 Labo-Flow dev environment is up
═══════════════════════════════════════════════════

  Unified entry:   http://localhost:3008
  Knowledge Base:  http://localhost:3008/rag/
  AI PPT:          http://localhost:3008/ppt/

  Direct access (debugging):
    Clawith frontend  http://localhost:3080
    Clawith backend   http://localhost:8008/api/health
    RAGFlow           http://localhost:8880
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

# RAGFlow SSO（必须与 JWT_SECRET_KEY 相同）
CLAWITH_JWT_SECRET_KEY=your-jwt-secret-key
RAGFLOW_PORT=8880
```

### 故障排查

| 问题 | 解决方案 |
|------|----------|
| 端口被占用 | `./stop.sh` 会清理已知端口；仍占用可手动 `lsof -i:3008` |
| NGINX 启动失败 | 检查 `include /etc/nginx/mime.types` 路径是否正确 |
| RAGFlow 解析任务卡住 | 确认 task executor 已启动（`dev.sh` 已内置）；查看 `.data/log/ragflow-task-executor.log` |
| RAGFlow chunks 为 0 | 确认 NLTK 数据已下载，见下方「RAGFlow 定制说明」 |
| 数据库连接失败 | 确认 Docker 依赖服务已启动：`docker compose -f ragflow/docker/docker-compose-base.yml up -d` |

查看日志：

```bash
tail -f .data/log/*.log
```

---

## RAGFlow 定制说明

> **重要**：`ragflow/` 是 RAGFlow 的 git submodule。LaboFlow 在其基础上做了**极少量定制**，升级 RAGFlow 时需注意以下文件的 merge。

### 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `ragflow/api/apps/restful_apis/user_api.py` | 新增代码（未改动原有逻辑） | 新增 `POST /v1/user/auth/sso/clawith` endpoint，验证 Clawith JWT 并自动注册用户 |
| `ragflow/web/src/pages/sso/index.tsx` | 新增文件 | SSO 落地页，提取 URL 中的 token 并向后端换取 RAGFlow session |
| `ragflow/conf/service_conf.yaml` | 本地配置（不提交） | 运行时配置，含数据库连接、模型等 |

### SSO 工作原理

```
Clawith 用户点击「知识库」
        │
        ▼
GET /api/enterprise/ragflow/sso-token   ← Clawith 后端签发 5 分钟 JWT
        │  { sub, email, role, aud:"ragflow", exp }
        │  签名密钥：JWT_SECRET_KEY
        ▼
window.open("{ragflow_url}/sso?token=JWT")
        │
        ▼
RAGFlow /sso 页面（新增文件）
        │  提取 token，POST 到后端
        ▼
POST /v1/user/auth/sso/clawith          ← RAGFlow 后端（新增 endpoint）
        │  验证签名（CLAWITH_JWT_SECRET_KEY）
        │  自动注册或登录用户
        ▼
RAGFlow session token → localStorage → 跳转 /home
```

### 升级 RAGFlow 时的注意事项

1. `user_api.py` 中新增的 endpoint 位于文件末尾，通常不会产生 conflict
2. `sso/index.tsx` 是全新文件，不会 conflict
3. 升级后运行 `git diff HEAD ragflow/` 检查是否有冲突

### 本地开发：NLTK 数据

RAGFlow 的 tokenizer 依赖 NLTK 语料库。Docker 镜像通过 `download_deps.py` 预置了这些数据，但本地 dev 模式需手动下载一次：

```bash
ragflow/.venv/bin/python -c "
import nltk
for pkg in ['punkt_tab', 'wordnet', 'omw-1.4',
            'averaged_perceptron_tagger', 'averaged_perceptron_tagger_eng',
            'stopwords']:
    nltk.download(pkg)
"
```

重建 Docker 镜像时，先执行 `python download_deps.py`，NLTK 数据会自动打包进镜像。

---

## 技术栈

| 组件 | 后端 | 前端 |
|------|------|------|
| **Clawith** | FastAPI · SQLAlchemy · PostgreSQL · Redis · JWT · MCP Client | React 19 · TypeScript · Vite · Zustand · TanStack Query |
| **RAGFlow** | Python · MySQL · Elasticsearch · MinIO · Redis | React · TypeScript · Vite |
| **AIPPT** | — | Vue 3 · TypeScript · Vite · Pinia · Konva.js · ECharts |

---

## 许可证

本项目基于 Apache 2.0 许可证开源。
