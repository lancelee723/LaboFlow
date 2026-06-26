# LaboFlow

> 咨询行业 AI 工作台 —— 集成 **Clawith**（多智能体协作平台）、**WeKnora**（RAG 知识库）、**Pro Slides**（LandPPT）和 **PPT-Master**（结构化 PPT 生成器）的一站式工作环境。

---

## 目录

- [1. 项目简介](#1-项目简介)
  - [定位](#定位)
  - [功能模块](#功能模块)
  - [系统架构](#系统架构)
- [2. Docker 版快速上手](#2-docker-版快速上手)
  - [前置依赖](#前置依赖)
  - [Step 1 — 克隆仓库并准备环境变量](#step-1--克隆仓库并准备环境变量)
  - [Step 2 — 生成两把密钥](#step-2--生成两把密钥)
  - [Step 3 — 填写 `.env` 与 `WeKnora/.env`](#step-3--填写-env-与-weknoraenv)
  - [Step 4 — 启动所有服务](#step-4--启动所有服务)
  - [Step 5 — 首次访问与注册](#step-5--首次访问与注册)
  - [其他部署变体](#其他部署变体)
- [3. LaboFlow 使用指南](#3-laboflow-使用指南)
  - [3.1 创建你的第一个 Agent](#31-创建你的第一个-agent)
  - [3.2 设置系统 LLM（Clawith 模型池）](#32-设置系统-llmclawith-模型池)
  - [3.3 设置 PPT-Master WebUI 的 LLM API Key](#33-设置-ppt-master-webui-的-llm-api-key)
- [4. 本地开发模式快速指南](#4-本地开发模式快速指南)
- [5. 进阶参考](#5-进阶参考)
  - [端口规划](#端口规划)
  - [目录结构](#目录结构)
  - [镜像构建与推送](#镜像构建与推送)
  - [WeKnora 集成与升级](#weknora-集成与升级)
  - [故障排查](#故障排查)
  - [许可证](#许可证)

---

## 1. 项目简介

### 定位

LaboFlow 面向**咨询行业**，把"做项目所需的三件事"——**协作、知识、交付**——整合到一个统一入口里：

- **协作**：用一群有"灵魂"（`soul.md`）和"记忆"（`memory.md`）的 AI 数字员工替你跑流程
- **知识**：把项目资料、行业数据、企业知识库做成 RAG 检索源，让 Agent 随时查得到
- **交付**：把对话沉淀的结论直接生成 PPT，免去手动排版

所有子系统共享一套 JWT 登录态，统一从 `http://localhost:3008` 进入。

### 功能模块

| 模块 | 技术栈 | 入口路径 | 角色 |
|------|--------|----------|------|
| **Clawith** | FastAPI + React 19 | `/` 、`/api`、`/ws` | 主平台：Agent 编排、IM、任务、SSO 颁发方 |
| **WeKnora** | Go + Vue 3 | `/kb/` | 企业知识库：文档解析、向量检索、GraphRAG |
| **Pro Slides** | LandPPT (FastAPI) | `/pro-slides/` | 自由风格 PPT 生成（H5/Markdown 风格） |
| **PPT-Master** | FastAPI + LangGraph + React | `/ppt-master/` | 结构化 PPT 生成（带模板、品牌系统、SVG 实时预览） |

> Pro Slides 与 PPT-Master 解决两类不同需求：前者偏"自由创意输出"，后者偏"模板化、品牌一致性的咨询交付物"。两者可同时启用，也可二选一。

### 系统架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          NGINX  (端口 3008)                              │
│                统一入口 · SSO Token 透传 · 反向代理路由                    │
├─────────────┬──────────────┬─────────────┬──────────────┬───────────────┤
│      /      │   /api /ws   │    /kb/     │ /pro-slides/ │ /ppt-master/  │
│  Clawith FE │  Clawith BE  │   WeKnora   │  Pro Slides  │  PPT-Master   │
├─────────────┴──────────────┴─────────────┴──────────────┴───────────────┤
│                          统一 SSO（JWT_SECRET_KEY）                       │
└─────────────────────────────────────────────────────────────────────────┘
         │              │                │                 │
         ▼              ▼                ▼                 ▼
  ┌────────────┐ ┌─────────────┐ ┌──────────────┐ ┌────────────────────┐
  │  Clawith   │ │   WeKnora   │ │  Pro Slides  │ │     PPT-Master     │
  │            │ │             │ │  (LandPPT)   │ │                    │
  │ PostgreSQL │ │ PostgreSQL  │ │   SQLite     │ │     PostgreSQL     │
  │   Redis    │ │  + pgvector │ │              │ │   + Gotenberg      │
  │            │ │   Redis     │ │              │ │   (PPTX 转换)       │
  │            │ │  DocReader  │ │              │ │                    │
  └────────────┘ └─────────────┘ └──────────────┘ └────────────────────┘
```

### 单点登录（SSO）原理

所有子系统共用 **同一把 `JWT_SECRET_KEY`** —— 这是整个 LaboFlow 跑通的关键：

```
用户在 Clawith 登录
        │
        ▼
Clawith 后端签发短时 SSO Token（5 min，audience 区分子系统）
        │   audience = "weknora" / "ppt-master" / "pro-slides"
        ▼
浏览器跳转 /kb/sso?token=… 、/ppt-master/sso?token=… 等
        │
        ▼
子系统用同一把 JWT_SECRET_KEY 验签 → 自动建账 / 颁发本地 access token
        │
        ▼
跳转到子系统主页，全程无二次登录
```

> 因此，**只要任何一个子系统的 JWT secret 与 Clawith 不一致，SSO 必然失败**。后面的环境变量章节会反复强调这一点。

---

## 2. Docker 版快速上手

这是面向**部署者**的零踩坑流程。所有步骤已在 macOS 与 Linux 上验证。

### 前置依赖

- **Docker** ≥ 24.0 + **Docker Compose v2**
- **Python 3** 或 **openssl**（仅用于生成密钥；不需要 Python 环境）
- 8 GB 以上可用内存
- 10 GB 以上磁盘（首次拉镜像约 6 GB）

> 国内用户如果拉镜像失败，请先配置 Docker 镜像加速器（参考 `Clawith/README.md` 中的"Docker Registry Mirror"段落）。

### Step 1 — 克隆仓库并准备环境变量

```bash
git clone https://github.com/lancelee723/LaboFlow.git
cd LaboFlow

# 复制根目录与 WeKnora 各自的环境变量模板
cp .env.example .env
cp WeKnora/.env.example WeKnora/.env
```

完成后会有两份 `.env`：

| 文件 | 作用 |
|------|------|
| `./.env` | 根目录：被 docker-compose 读取，由 Clawith、Pro Slides、PPT-Master 共享 |
| `./WeKnora/.env` | WeKnora 专属：被 `WeKnora/docker-compose.yml`（include 进根编排）单独读取 |

### Step 2 — 生成两把密钥

LaboFlow 需要两把**全局密钥**，必须自己生成，不能用模板里的默认值。

```bash
# ① JWT_SECRET_KEY — SSO 签名密钥，跨所有子系统共用
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'

# ② SYSTEM_AES_KEY — 数据库字段加密密钥（恰好 32 字节，无尾部 = 号）
openssl rand -base64 32 | tr -d '=\n' | cut -c1-32
```

把这两个值记下来，下一步会用到。

> **为什么是 32 字节？** WeKnora 用 AES-256-GCM 加密 `tenant.api_key`、`app.secret` 等敏感字段。AES-256 的密钥固定 32 字节，少了或多了都会启动失败。

### Step 3 — 填写 `.env` 与 `WeKnora/.env`

#### ① 根目录 `.env`

打开 `./.env`，**至少修改下面 4 项**：

```bash
# ── SSO / JWT（必填）─────────────────────────────
JWT_SECRET_KEY=<Step 2 生成的第①个值>

# ── AES 加密（必填）─────────────────────────────
SYSTEM_AES_KEY=<Step 2 生成的第②个值>

# ── 公网/局域网访问地址 ─────────────────────────
# 本机调试保持默认即可。部署到内网/公网时，改成实际访问地址，
# 例如 http://192.168.1.10:3008 或 https://laboflow.your-domain.com
PUBLIC_BASE_URL=http://localhost:3008

# ── PPT-Master 初始管理员（首次启动种子用户）────
# Clawith 未配置 SSO 前，可用这对账号直接登 PPT-Master
PPTMASTER_INITIAL_ADMIN_EMAIL=admin@your-company.com
PPTMASTER_INITIAL_ADMIN_PASSWORD=<请改成 12 位以上强密码>
```

其余字段（`NGINX_PORT`、各服务端口、PPT-Master 数据库账密等）**保留默认即可**，除非有端口冲突。

#### ② WeKnora 的 `./WeKnora/.env`

打开 `./WeKnora/.env`，**确保以下三项与根 `.env` 完全一致**：

```bash
# ⚠️ 这三个值必须分别与根 .env 中的 JWT_SECRET_KEY / JWT_SECRET_KEY / SYSTEM_AES_KEY 一字不差
JWT_SECRET=<根 .env 的 JWT_SECRET_KEY>
CLAWITH_SSO_SECRET=<根 .env 的 JWT_SECRET_KEY>
SYSTEM_AES_KEY=<根 .env 的 SYSTEM_AES_KEY>

# WeKnora 内部数据库密码（保留默认即可，已隔离在容器内）
DB_PASSWORD=postgres123!@#
```

> 一句话记忆：**Clawith 的 `JWT_SECRET_KEY` ＝ WeKnora 的 `JWT_SECRET` ＝ WeKnora 的 `CLAWITH_SSO_SECRET`**。三个名字不同，但必须装同一个字符串。

#### JWT 密钥配置对照表

| 配置项 | 文件 | 取值 | 用途 |
|--------|------|------|------|
| `JWT_SECRET_KEY` | `./.env` | Step 2 生成的 ① | Clawith 颁发 + 验签 SSO Token |
| `JWT_SECRET` | `./WeKnora/.env` | 同上 | WeKnora 验签 Clawith 颁发的 SSO Token |
| `CLAWITH_SSO_SECRET` | `./WeKnora/.env` | 同上 | WeKnora 跨产品 SSO 校验 |
| `SYSTEM_AES_KEY` | `./.env` + `./WeKnora/.env` | Step 2 生成的 ② | 数据库敏感字段加解密 |

### Step 4 — 启动所有服务

```bash
docker compose up -d
```

首次启动会拉取约 6 GB 镜像，时间 5–15 分钟取决于网络。完成后查看状态：

```bash
docker compose ps
```

期望看到约 13 个容器全部 `running` 或 `healthy`（`pptmaster-init` 是一次性容器，正常会 `exited (0)`）。

查看日志：

```bash
docker compose logs -f clawith-backend       # 主平台后端
docker compose logs -f app                   # WeKnora 后端
docker compose logs -f pptmaster-worker      # PPT-Master 后端
docker compose logs -f nginx                 # 统一入口
```

停止所有服务：

```bash
docker compose down       # 保留数据卷
docker compose down -v    # 同时清空数据（⚠️ 不可逆）
```

### Step 5 — 首次访问与注册

打开浏览器访问：

| 入口 | URL |
|------|-----|
| **Clawith 主平台**（推荐首次入口） | http://localhost:3008 |
| WeKnora 知识库 | http://localhost:3008/kb/ |
| Pro Slides | http://localhost:3008/pro-slides/ |
| PPT-Master | http://localhost:3008/ppt-master/ |

**初次注册的用户会自动成为平台管理员（platform_admin）**，请使用你自己的邮箱注册。后续用户注册都属于普通成员。

进入主平台后，建议下一步：
1. → **3.2 设置系统 LLM** —— 没有这一步 Agent 就跑不起来
2. → **3.1 创建你的第一个 Agent**

### 其他部署变体

| 编排文件 | 适用场景 | 说明 |
|------|------|------|
| `docker-compose.yml` | **默认完整版**（推荐） | Clawith + WeKnora + Pro Slides + PPT-Master + NGINX |
| `docker-compose-fnos.yml` | 飞牛 NAS 等 IPv6-only 环境 | 在 IPv6-only `/etc/hosts` 下规避 wget/dig 解析 `::1` 的问题 |
| `docker-compose.dev-override.yml` | 仅供 `dev.sh` 使用 | 把 WeKnora 开发端口让给本地 Go 进程 |

部署到生产时，可在外层再套一层反向代理（Lucky / Nginx Proxy Manager / Caddy 等）做 HTTPS 终止，把 LaboFlow 的 NGINX (`3008`) 作为上游即可。

---

## 3. LaboFlow 使用指南

### 3.1 创建你的第一个 Agent

> 前置：请先完成 **3.2 设置系统 LLM**，否则 Agent 创建后会因为找不到模型而无法对话。

1. 打开 http://localhost:3008，用首次注册的管理员账号登录
2. 左侧导航栏点击 **"Agents"** → 右上角 **"+ New Agent"**
3. 在表单中填写：
   - **Name**：例如 `项目经理小李`
   - **Avatar**：可选；上传一张头像或用默认色块
   - **Soul**（关键）：写一段"人设/职责说明"，会被注入到每次对话的 system prompt 中
     ```
     你是一个资深咨询项目经理，负责跟踪项目进度、维护 OKR 表、
     周期性催办交付物。回复风格严谨、简洁，引用事实而非主观判断。
     ```
   - **Model**：从下拉选你在 3.2 配置的模型（如 `anthropic/claude-sonnet-4-20250514`）
4. 点击 **Create**

创建完成后 Agent 会出现在列表里，点击进入即可对话。Agent 拥有自己独立的：
- **soul.md**（性格 + 职责）
- **memory.md**（长期记忆，跨会话保留）
- **workspace**（私有文件系统，宿主机映射在 `Clawith/backend/agent_data/<agent-id>/`）
- **Aware 触发器**（cron / interval / webhook / on_message —— 让 Agent 自主行动）

#### 让 Agent 调用知识库 / PPT-Master

在 Agent 详情页右侧 **Tools / MCP** 面板：

- **接入 WeKnora 知识库**：勾选 `weknora_search` 工具，Agent 即可在对话中调用 RAG 检索
- **接入 PPT-Master**：在 Clawith 后台 **Enterprise → Integrations** 中绑定 PPT Agent ID，让对话直接产出 PPT

### 3.2 设置系统 LLM（Clawith 模型池）

Clawith 的每个 Agent 都从**租户级模型池**里选模型。首次部署需要先往池里加至少一个模型。

1. 登录 Clawith → 左下角点击你的头像 → **Enterprise Settings**
2. 找到 **LLM Model Pool**（中文界面：**模型池**）卡片
3. 点击 **"+ Add Model"**，按以下字段填写：

| 字段 | 示例 | 说明 |
|------|------|------|
| **Provider** | `anthropic` / `openai` / `deepseek` / `qwen` / `gemini` / `zhipu` / `kimi` / `openrouter` / `ollama` / `vllm` | 选一个内置 Provider |
| **Model** | `claude-sonnet-4-20250514`、`gpt-4o`、`deepseek-chat` … | Provider 给你的模型 ID |
| **API Key** | `sk-...` | 从 Provider 控制台拿 |
| **Base URL**（可选） | `https://api.deepseek.com/v1` | 用代理或自托管时填 |
| **Display Name**（可选） | `Claude 4 Sonnet` | Agent 下拉框里显示的名字 |

4. 点 **Save** 之后建议先点 **Test**，看到 `OK` 才算成功
5. 可一次性加多个模型；后续创建 Agent 时可挑选

> 数据安全：API Key 用 `SYSTEM_AES_KEY` 加密后存进数据库；前端不会回显明文。

#### 内置支持的 Provider

`anthropic`（Claude）· `openai`（GPT）· `gemini`（Google）· `deepseek` · `qwen`（百炼 DashScope）· `ollama`（本地）· `vllm` · `zhipu`（智谱 GLM）· `kimi`（Moonshot）· `minimax` · `baidu`（百度千帆）· `openrouter`

### 3.3 设置 PPT-Master WebUI 的 LLM API Key

PPT-Master 有**独立的 LLM 配置**（与 Clawith 模型池隔离），原因是：PPT 生成对模型能力、上下文窗口、JSON 输出稳定性有特殊要求，往往需要专门挑选模型。

1. 用 SSO 进入 PPT-Master：登录 Clawith 后访问 http://localhost:3008/ppt-master/
   - 如果 SSO 暂时不可用，也可用 `.env` 里设置的 `PPTMASTER_INITIAL_ADMIN_EMAIL/PASSWORD` 直接登录
2. 左侧导航 → **Settings**（设置）→ **LLM Providers**（模型提供商）
3. 点 **Add Configuration**，填写：

| 字段 | 示例 |
|------|------|
| **Provider** | `anthropic` / `openai` / `gemini` / `deepseek` / `qwen` / `ollama` 等 |
| **Model** | `claude-sonnet-4-20250514`、`gpt-4o`、`deepseek-chat`… |
| **API Key** | 该 Provider 的密钥 |
| **Base URL**（可选） | 代理或自托管时填 |
| **Display Name**（可选） | 在 PPT 任务面板里显示的别名 |
| **Role**（可选） | `writer`（撰写正文）/ `planner`（规划大纲）/ 留空＝全角色可用 |

4. 点 **Test** 验证可用，再点 **Save**

#### 给不同环节用不同模型（推荐）

PPT-Master 内部把生成过程拆成 **planner（规划大纲）+ writer（写正文）+ designer（选模板）** 等多个 Agent 角色。你可以：

- 给 `planner` 配 GPT-4o 或 Claude Sonnet（推理强）
- 给 `writer` 配更便宜的 `deepseek-chat` 或 `qwen-plus`（量大）
- 不指定 Role 的配置会作为兜底，所有角色都能选

#### 与 Clawith 模型池的关系

| 维度 | Clawith 模型池 | PPT-Master LLM Providers |
|------|----------------|--------------------------|
| 作用范围 | Agent 对话 | PPT 生成流水线 |
| 是否共享 | ✗ 各自独立 | ✗ 各自独立 |
| API Key | 加密存储在 Clawith 数据库 | 加密存储在 PPT-Master 数据库 |
| AES 密钥 | 都用同一把 `SYSTEM_AES_KEY` | 同左 |

如果你只想配一处，可以把 Clawith 的 LLM 暴露给 PPT-Master 通过 `VITE_CUSTOM_LLM_URL` 走 LLM 代理（参见 `.env.example` 注释），但**默认建议各配各的**，便于精细控制。

---

## 4. 本地开发模式快速指南

如果你要改代码（前后端热重载），用 `dev.sh` 模式更顺手。它会把基础设施（PostgreSQL / Redis / DocReader / Gotenberg）跑在 Docker 里，把业务进程（FastAPI / Vite / Go）跑在宿主机。

### 一次性初始化

```bash
cd LaboFlow

# 准备 .env（同 Docker 模式的 Step 1–3，照做即可）
cp .env.example .env
cp WeKnora/.env.example WeKnora/.env
# … 编辑 .env / WeKnora/.env，填好 JWT_SECRET_KEY、SYSTEM_AES_KEY

# 一键安装所有子系统依赖（Python venv、npm、Go mod、uv sync 等）
./setup-all.sh
```

`setup-all.sh` 会：
1. 校验本机有没有 `nginx`、`uv`、`pnpm`、`python3 ≥ 3.12`
2. 在 `Clawith/backend/.venv` 安装 Python 依赖、跑 alembic 迁移
3. 安装 Clawith 前端 npm 包
4. 拉起 WeKnora 的 dev 基础设施容器
5. 安装 Pro Slides（LandPPT）和 PPT-Master 的依赖

> 该脚本要求本机已装：Docker、`nginx`、`uv`、`pnpm`、`go ≥ 1.23`、Python ≥ 3.12。

### 启动开发环境

```bash
./dev.sh
```

成功输出形如：

```
═══════════════════════════════════════════════════
  Labo-Flow dev environment is up
═══════════════════════════════════════════════════

  Unified entry:   http://localhost:3008
  Knowledge Base:  http://localhost:3008/kb/
  AI PPT:          http://localhost:3008/ppt/
  PPT Master:      http://localhost:3008/ppt-master/

  Direct access (debugging):
    Clawith frontend  http://localhost:3080
    Clawith backend   http://localhost:8008/api/health
    WeKnora backend   http://localhost:8080
    WeKnora frontend  http://localhost:8800/kb/
    Pro Slides        http://localhost:7456
    PPT-Master webui  http://localhost:5990
    PPT-Master worker http://localhost:5991/health

  Logs:   tail -f .data/log/*.log
  Stop:   ./stop.sh
```

### 开发模式特性

- **热重载**：Clawith 后端 uvicorn `--reload`；前端 Vite HMR；WeKnora 后端可选用 [air](https://github.com/cosmtrek/air) 监听
- **复用容器**：`dev.sh` 不会从镜像仓库拉新镜像，PPT-Master 用到的 Postgres / Gotenberg 全程复用本地已存在的容器与镜像（详见 `dev.sh` 注释）
- **PID / 日志统一管理**：`.data/pid/` 存所有进程 PID，`.data/log/` 存所有日志
- **测试模式**：`./dev.sh --test` 只跑 Clawith 后端的 pytest，不启动服务

停止：

```bash
./stop.sh
```

---

## 5. 进阶参考

### 端口规划

| 服务 | Dev 端口 | Docker 内部端口 | NGINX 路径 |
|------|----------|-----------------|------------|
| **NGINX 统一入口** | 3008 | 80 | — |
| Clawith 前端 | 3080 | 3000 | `/` |
| Clawith 后端 | 8008 | 8000 | `/api`, `/ws` |
| WeKnora 前端 | 8800 | 80 | `/kb/` |
| WeKnora 后端（gRPC + HTTP） | 8080 / 50051 | 8080 / 50051 | 由前端反代 |
| Pro Slides (LandPPT) | 7456 | 7456 | `/pro-slides/` |
| PPT-Master WebUI | 5990 | 80 | `/ppt-master/` |
| PPT-Master Worker | 5991 | 8000 | `/ppt-master/api/` |
| PPT-Master Postgres | 5992 | 5432 | （仅内部） |
| PPT-Master Converter (Gotenberg) | 5993 | 3000 | （仅内部） |

### 目录结构

```
LaboFlow/
├── Clawith/                     # 主平台
│   ├── backend/                 # FastAPI + SQLAlchemy
│   ├── frontend/                # React 19 + Vite
│   └── docker/                  # 镜像 Dockerfile
├── WeKnora/                     # 知识库（腾讯开源 + LaboFlow 定制 SSO）
│   ├── internal/                # Go 后端
│   ├── frontend/                # Vue 3
│   │   └── Dockerfile.laboflow  # 以 /kb/ 为 base 的定制构建
│   └── migrations/              # SQL 迁移
├── Pro Slides/                  # LandPPT — Python/FastAPI 自由式 PPT 生成
│   ├── run.py
│   └── src/landppt/
├── PPT-Master/                  # 结构化 PPT 生成器
│   ├── apps/worker/             # FastAPI + LangGraph 后端
│   ├── apps/webui/              # React + Vite 前端
│   ├── alembic/                 # 数据库迁移
│   └── skills/ppt-master/       # 模板包 + 生成脚本
├── nginx.conf                   # NGINX 配置（dev 模式）
├── nginx/docker.conf            # NGINX 配置（Docker 模式）
├── docker-compose.yml           # 主编排（默认完整版）
├── docker-compose-fnos.yml      # 飞牛 NAS 专用编排
├── docker-image-manager.sh      # 交互式镜像构建/推送脚本
├── setup-all.sh                 # 一次性安装所有依赖
├── dev.sh                       # 开发模式启动
├── stop.sh                      # 停止所有服务
├── .env.example                 # 共享环境变量模板
└── .data/                       # 运行时数据（PID、日志、本地存储）
```

### 镜像构建与推送

仓库提供交互式脚本 `docker-image-manager.sh`，统一管理：

```bash
chmod +x docker-image-manager.sh
./docker-image-manager.sh
```

当前管理的镜像：

- `docker-clawith-backend` / `docker-clawith-frontend`
- `docker-weknora-app` / `docker-weknora-docreader` / `docker-weknora-frontend`
- `docker-pro-slides`
- `docker-pptmaster-worker` / `docker-pptmaster-webui`
- `docker-nginx`

推送到私有仓库后，可在 `.env` 中通过 `REGISTRY=` 和 `TAG=` 让 Compose 编排直接拉对应版本。

### WeKnora 集成与升级

> WeKnora 是腾讯开源的 RAG 框架。LaboFlow 在其基础上做了**少量定制**以接入 SSO。

#### 定制文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `WeKnora/frontend/vite.config.ts` | 修改 | 新增 `base` 配置支持 `VITE_BASE_URL` |
| `WeKnora/frontend/Dockerfile.laboflow` | 新增 | 以 `/kb/` 为 base 的专用构建 |
| `WeKnora/frontend/src/views/auth/SSO.vue` | 新增 | SSO 落地页：提取 URL token → 后端换 session |
| `WeKnora/internal/handler/auth.go` | 新增 | `SSOClawithLogin` handler |
| `WeKnora/internal/application/service/user.go` | 新增 | `LoginWithSSO` 自动建账方法 |
| `WeKnora/internal/middleware/auth.go` | 修改 | 把 `/api/v1/auth/sso/clawith` 加入白名单 |
| `WeKnora/internal/router/router.go` | 修改 | 注册 SSO 路由 |

#### 升级 WeKnora 上游版本时

1. `vite.config.ts` 的 `base` 配置可能需要手动合并
2. `auth.go` 和 `user.go` 中新增方法通常位于文件末尾，不会冲突
3. 升级后跑 `git diff HEAD WeKnora/` 复核改动
4. 如果 SSO 失效，先检查 `JWT_SECRET / CLAWITH_SSO_SECRET` 是否与根 `.env` 的 `JWT_SECRET_KEY` 完全一致

#### MinerU 增强文档解析（可选）

WeKnora 默认的 DocReader 已能处理常见格式。如需更高质量的 PDF / 公式 / 表格解析：

```bash
# 启用 MinerU profile
docker compose --profile mineru up -d mineru

# 在 WeKnora/.env 中配置
MINERU_ENDPOINT=http://mineru:9930
```

### 故障排查

| 现象 | 排查方向 |
|------|----------|
| `docker compose up -d` 卡在拉镜像 | 配置 Docker Registry Mirror（参考 `Clawith/README.md`） |
| SSO 登录后跳回登录页 | 检查 `JWT_SECRET_KEY`（根 .env）与 `JWT_SECRET / CLAWITH_SSO_SECRET`（WeKnora/.env）是否完全一致 |
| WeKnora 启动报 `AES key size 0` | `SYSTEM_AES_KEY` 没设置或不足 32 字节，重新用 `openssl rand -base64 32 \| tr -d '=\n' \| cut -c1-32` 生成 |
| Clawith Agent 无法对话，提示 "no available model" | 还没在 Enterprise Settings → LLM Model Pool 加模型 |
| PPT-Master 报 "no LLM configuration available" | 还没在 PPT-Master Settings → LLM Providers 加模型 |
| 端口被占用 | `./stop.sh` 清理 dev 模式残留；仍占用用 `lsof -i:3008` 排查 |
| WeKnora 文档解析失败 | `docker compose logs docreader` 看 gRPC 状态 |
| 数据库迁移失败 | `docker compose logs pptmaster-init` 或 `weknora-migrate`，多数情况是密钥 / 端口冲突 |

查看日志：

```bash
# Docker 模式
docker compose logs -f <service-name>

# Dev 模式
tail -f .data/log/*.log
```

### 许可证

本项目基于 **Apache 2.0** 开源。各子组件遵循各自的开源许可证（详见各组件目录下的 `LICENSE`）。
