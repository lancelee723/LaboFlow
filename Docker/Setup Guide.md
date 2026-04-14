# LaboFlow Docker 部署指南

本指南帮助你在服务器上通过 Docker 一键部署 LaboFlow。

---

## 前置条件

| 要求 | 最低版本 | 验证命令 |
|------|---------|---------|
| Docker Engine | 20.10+ | `docker --version` |
| Docker Compose | v2.0+ | `docker compose version` |
| 磁盘空间 | 10GB+ | — |
| 内存 | 4GB+ | — |

---

## 第一步：准备项目文件

将以下文件上传到服务器同一目录（如 `/opt/laboflow`）：

```
/opt/laboflow/
├── docker-compose.yml
├── .env.example
└── .env
```

> 你只需上传 `Docker/` 目录下的 `docker-compose.yml` 和 `.env.example`，无需上传源码。

---

## 第二步：登录阿里云镜像仓库

自建镜像托管在阿里云私有仓库，需要先登录才能拉取：

```bash
docker login crpi-oxztsn6qggvtnlnf.cn-guangzhou.personal.cr.aliyuncs.com
```

按提示输入阿里云账号的用户名和密码。登录成功后会显示 `Login Succeeded`。

---

## 第三步：配置环境变量

```bash
cd /opt/laboflow
cp .env.example .env
vim .env
```

**必须修改的变量**：

| 变量 | 说明 | 修改方式 |
|------|------|---------|
| `SECRET_KEY` | Clawith 应用密钥 | 生成强随机值：`python3 -c 'import secrets; print(secrets.token_urlsafe(48))'` |
| `JWT_SECRET_KEY` | JWT 签名密钥（三组件共享 SSO） | 同上，生成另一个强随机值 |
| `POSTGRES_PASSWORD` | 数据库密码 | 替换默认的 `clawith` 为强密码 |

**按需修改的变量**：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NGINX_PORT` | 对外暴露端口 | `3008` |
| `PUBLIC_BASE_URL` | 公开访问 URL | `http://localhost:3008` |
| `LIGHTRAG_LLM_BINDING_API_KEY` | LightRAG 的 LLM API Key | 空 |
| `LIGHTRAG_LLM_MODEL` | LightRAG 使用的模型 | `gpt-4o-mini` |
| `LIGHTRAG_LLM_BINDING_HOST` | LLM API 地址 | `https://api.openai.com/v1` |
| `LIGHTRAG_EMBEDDING_MODEL` | Embedding 模型 | `text-embedding-3-small` |

完整的 `.env` 模板如下：

```env
# ══ Container Registry ══
REGISTRY=crpi-oxztsn6qggvtnlnf.cn-guangzhou.personal.cr.aliyuncs.com/laboflow
TAG=latest

# ══ Unified entry ══
NGINX_PORT=3008
PUBLIC_BASE_URL=http://localhost:3008

# ══ Database (PostgreSQL) ══
POSTGRES_USER=clawith
POSTGRES_PASSWORD=clawith
POSTGRES_DB=clawith

# ══ Clawith (main platform) ══
SECRET_KEY=change-me-in-production
JWT_SECRET_KEY=change-me-jwt-secret
JWT_ALGORITHM=HS256

# ══ LightRAG (knowledge base) ══
LIGHTRAG_LLM_BINDING=openai
LIGHTRAG_LLM_MODEL=gpt-4o-mini
LIGHTRAG_LLM_BINDING_HOST=https://api.openai.com/v1
LIGHTRAG_LLM_BINDING_API_KEY=
LIGHTRAG_EMBEDDING_BINDING=openai
LIGHTRAG_EMBEDDING_MODEL=text-embedding-3-small
LIGHTRAG_EMBEDDING_DIM=1536
```

---

## 第四步：拉取镜像

```bash
docker compose pull
```

此命令会拉取以下镜像：

| 镜像 | 来源 | 用途 |
|------|------|------|
| `*/docker-clawith-backend:latest` | 阿里云私有仓库 | Clawith 后端（FastAPI） |
| `*/docker-clawith-frontend:latest` | 阿里云私有仓库 | Clawith 前端（React + Nginx） |
| `*/docker-lightrag:latest` | 阿里云私有仓库 | 知识库引擎（FastAPI + WebUI） |
| `*/docker-aippt:latest` | 阿里云私有仓库 | AI PPT（Vue + Nginx） |
| `*/docker-nginx:latest` | 阿里云私有仓库 | 统一反向代理网关 |
| `postgres:15.12-alpine` | Docker Hub | 数据库 |
| `redis:7.4.2-alpine` | Docker Hub | 缓存 |

---

## 第五步：启动服务

```bash
  docker compose up -d
```

验证所有服务是否正常运行：

```bash
docker compose ps
```

预期输出：7 个服务状态均为 `running`（或 `healthy`）。

---

## 第六步：访问应用

浏览器打开：

```
http://<服务器IP>:3008
```

| 路径 | 功能 |
|------|------|
| `/` | Clawith 主平台 |
| `/kb/` | LightRAG 知识库 |
| `/ppt/` | AI PPT |

---

## 常用运维命令

### 查看日志

```bash
# 查看所有服务日志
docker compose logs -f

# 查看单个服务日志
docker compose logs -f clawith-backend
docker compose logs -f lightrag
```

### 重启服务

```bash
# 重启所有服务
docker compose restart

# 重启单个服务
docker compose restart clawith-backend
```

### 更新镜像

```bash
docker compose pull
docker compose up -d
```

### 停止服务

```bash
docker compose down
```

> ⚠️ `docker compose down` 不会删除数据卷。如需彻底清除数据，使用 `docker compose down -v`。

### 备份数据库

```bash
docker compose exec postgres pg_dump -U clawith clawith > backup_$(date +%Y%m%d).sql
```

### 恢复数据库

```bash
cat backup_20260413.sql | docker compose exec -T postgres psql -U clawith clawith
```

---

## 架构概览

```
                    ┌─────────────┐
                    │   Nginx     │ :3008 (对外)
                    │   网关      │
                    └──────┬──────┘
           ┌──────────┬────┼────┬──────────┐
           │          │    │    │          │
      ┌────▼───┐ ┌───▼──┐ │ ┌──▼───┐ ┌───▼────┐
      │ Clawith│ │Light │ │ │ AIPPT│ │Clawith │
      │ 前端   │ │RAG   │ │ │      │ │ 后端   │
      └────────┘ └──────┘ │ └──────┘ └───┬────┘
                          │               │
                    ┌─────▼─────┐   ┌─────▼─────┐
                    │  Redis    │   │ PostgreSQL│
                    └───────────┘   └───────────┘
```

所有服务运行在 `laboflow` Docker 网络中，仅 Nginx 网关对外暴露端口。

---

## 故障排查

| 问题 | 排查方式 |
|------|---------|
| 服务启动失败 | `docker compose logs <服务名>` 查看错误日志 |
| 数据库连接失败 | 检查 `POSTGRES_PASSWORD` 是否一致；确认 postgres 服务已 healthy |
| SSO 登录失败 | 确认 `JWT_SECRET_KEY` 在 `.env` 中已正确设置 |
| LightRAG 无法调用 LLM | 检查 `LIGHTRAG_LLM_BINDING_API_KEY` 是否已填入有效 API Key |
| 端口被占用 | 修改 `.env` 中的 `NGINX_PORT` 为其他端口 |
| 镜像拉取失败（私有仓库） | 确认已执行 `docker login`；检查网络连通性 |
| 镜像拉取失败（Docker Hub） | 配置 Docker 镜像加速器或代理 |

---

## 数据持久化

以下数据通过 Docker Volume 持久化，容器重建后不会丢失：

| Volume | 内容 |
|--------|------|
| `pgdata` | PostgreSQL 数据库 |
| `redisdata` | Redis 缓存 |
| `agent_data` | Clawith Agent 数据 |
| `rag_storage` | LightRAG 知识库存储 |
| `lightrag_inputs` | LightRAG 输入文件 |
