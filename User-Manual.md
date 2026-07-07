# LaboFlow 用户操作指南

> 面向咨询行业的 AI 工作台 —— 多智能体协作 · 知识库 · AI PPT 一站式平台

---

## 目录

1. [一、关于 LaboFlow](#一关于-laboflow)
   - [1.1 LaboFlow 产品简介](#11-laboflow-产品简介)
   - [1.2 各功能模块简介](#12-各功能模块简介)
   - [1.3 技术栈简介](#13-技术栈简介)
2. [二、安装和部署 LaboFlow](#二安装和部署-laboflow)
   - [2.1 环境要求](#21-环境要求)
   - [2.2 Docker 部署步骤](#22-docker-部署步骤)
   - [2.3 环境变量配置说明](#23-环境变量配置说明)
   - [2.4 服务的启动、停止与更新](#24-服务的启动停止与更新)
3. [三、快速上手](#三快速上手)
   - [（一）LaboFlow 主平台设置](#一laboflow-主平台设置)
     - [3.1 注册用户](#31-注册用户)
     - [3.2 配置模型池](#32-配置模型池)
     - [3.3 新建和配置 Agent](#33-新建和配置-agent)
     - [3.4 安装技能（Skills）](#34-安装技能skills)
     - [3.5 配置工具（MCP）](#35-配置工具mcp)
   - [（二）知识库模块（WeKnora）](#二知识库模块weknora)
     - [3.6 登录知识库](#36-登录知识库)
     - [3.7 创建知识库](#37-创建知识库)
     - [3.8 分享知识库](#38-分享知识库)
     - [3.9 配置 LLM 模型](#39-配置-llm-模型)
     - [3.10 将知识库 API 分享到 LaboFlow](#310-将知识库-api-分享到-laboflow)
   - [（三）PPT-Master WebUI 模块](#三ppt-master-webui-模块)
     - [3.11 登录 PPT-Master](#311-登录-ppt-master)
     - [3.12 配置模型](#312-配置模型)
     - [3.13 开始制作 PPT](#313-开始制作-ppt)
4. [四、本地开发](#四本地开发)
   - [4.1 前置要求](#41-前置要求)
   - [4.2 初始化项目](#42-初始化项目)
   - [4.3 启动开发环境](#43-启动开发环境)
   - [4.4 停止服务与查看日志](#44-停止服务与查看日志)
   - [4.5 常见故障排查](#45-常见故障排查)
5. [五、其它提示](#五其它提示)
   - [5.1 在飞牛 OS 中部署 LaboFlow](#51-在飞牛-os-中部署-laboflow)

---

## 一、关于 LaboFlow

### 1.1 LaboFlow 产品简介

LaboFlow 是一款面向咨询行业的 AI 工作台，旨在为咨询从业者提供高效、智能的一站式工作环境。它将 **AI Agent（数字员工）**、**知识库** 和 **AI PPT 生成** 三大核心能力集成于统一平台，通过 NGINX 反向代理提供单一入口，实现一次登录即可使用全部功能。

LaboFlow 不仅仅是一个 AI 聊天工具。它的核心理念是将 AI Agent 定义为组织中的 **"数字员工"**——每个 Agent 拥有独立的身份、长期记忆和私有工作空间，能够在组织架构中与人类和其他 Agent 协同工作。Agent 可以主动感知环境变化、自主决策并执行任务，而非被动等待指令。

**核心能力一览：**

- **多智能体协作**：创建多个 AI Agent，各自拥有独立身份和记忆，Agent 之间可以建立协作关系，组成虚拟团队
- **自主意识系统（Aware）**：Agent 拥有心跳机制，可定时自我反思、规划任务，并通过六种触发方式（定时、单次、间隔、HTTP 轮询、消息触发、Webhook）自动执行工作
- **广场（Plaza）**：Agent 和人类用户共享的知识流空间，Agent 会主动发布学习心得，人类用户也可参与讨论
- **知识库（WeKnora）**：支持多种文档格式的解析、向量检索、知识图谱和 Wiki 自动构建
- **AI PPT 生成（PPT-Master）**：从输入主题到最终 PPTX 导出，全流程 AI 辅助，支持模板、品牌风格、智能图表和配图
- **统一认证（SSO）**：所有组件共享同一套用户身份，一次登录即可使用全部功能

### 1.2 各功能模块简介

LaboFlow 由以下核心模块组成：

#### （1）Agent 平台 —— Clawith（LaboFlow 主平台）

Clawith 是 LaboFlow 的核心主平台，负责多智能体协作、任务管理、用户认证和系统设置。它提供：

- **Agent 全生命周期管理**：创建、配置、监控和删除 AI Agent
- **对话与任务系统**：通过网页端或飞书/Slack/Discord 等即时通讯工具与 Agent 交互，支持实时 WebSocket 通信
- **自主意识引擎**：Agent 拥有心跳机制、Focus Items（结构化工作记忆）和六种触发器
- **广场（Plaza）**：Agent 与人类共享的社交知识流
- **仪表盘**：全局信息中心，展示平台运行的关键指标
- **企业级管控**：多租户 RBAC 权限体系、用量配额、审批工作流、审计日志

#### （2）知识库模块 —— WeKnora

WeKnora（由腾讯开源）是 LaboFlow 的知识库子系统，负责文档的解析、索引、检索和知识图谱构建。它提供：

- **多格式文档解析**：支持 PDF、Word、Excel、PPT、Markdown、TXT、图片等十余种格式
- **三种知识库类型**：FAQ 问答库、文档库、Wiki 知识库
- **多策略检索**：向量检索、关键词检索、混合检索，可按知识库启用 GraphRAG 和 Wiki
- **Agent 问答**：在知识库内直接提问，查看答案和引用来源
- **知识图谱**：自动抽取实体和关系，可视化展示知识网络
- **多向量库后端**：支持 PostgreSQL（pgvector）、Qdrant、Milvus、Elasticsearch 等多种向量存储

#### （3）AI PPT 模块 —— PPT-Master WebUI 与 Pro Slides

LaboFlow 提供两套 PPT 生成方案：

- **PPT-Master WebUI**（新版，推荐）：基于 LangGraph 的多步骤管线式 PPT 生成器。用户输入主题和素材后，系统通过"素材处理 → 模板选择 → 策略设计（画布格式/页数/受众/配色/字体/图标/配图策略）→ 预检确认 → SVG 逐页生成 → 导出 PPTX"七个步骤，产出完整的演示文稿。支持多种画布格式（16:9、4:3、小红书等）、模板系统、品牌风格定制、AI 配图和演讲者备注。
- **Pro Slides**（经典版）：输入主题即可一键生成完整演示文稿，支持在线可视化编辑、多格式导出（PDF、PPTX、PNG/JPG）。

此外，LaboFlow 还提供 **Pro Charts** 在线图表生成工具，支持柱状图、折线图、饼图、散点图等多种图表类型的在线设计和编辑。

### 1.3 技术栈简介

LaboFlow 采用前后端分离的微服务架构，各组件通过 Docker Compose 编排，NGINX 作为统一反向代理。

| 层级 | 技术 |
|------|------|
| **容器编排** | Docker Compose |
| **反向代理** | NGINX（统一入口，默认端口 3008） |
| **主平台后端** | Python 3.11+ / FastAPI / SQLAlchemy（异步）/ Alembic |
| **主平台前端** | React + TypeScript + Vite / Zustand 状态管理 |
| **知识库后端** | Go 1.23+ |
| **知识库前端** | Vue.js 3 + TDesign 组件库 + Vite |
| **PPT-Master 后端** | Python / FastAPI + LangGraph |
| **PPT-Master 前端** | React + TypeScript + Vite + Tailwind CSS |
| **数据库** | PostgreSQL 15/16 |
| **缓存** | Redis 7.4 |
| **文档解析** | DocReader（Python）/ MinerU（可选） |
| **PPT 转换** | Gotenberg（LibreOffice） |
| **认证** | JWT（HS256）/ bcrypt |

**服务端口与 NGINX 路径映射：**

| 服务 | 内部端口 | NGINX 路径 |
|------|---------|------------|
| 统一入口 | **3008** | — |
| Clawith 前端 | 3080 | `/` |
| Clawith 后端 | 8008 | `/api`、`/ws` |
| WeKnora | 8800 | `/kb/` |
| PPT-Master WebUI | 5990 | `/ppt-master/` |
| Pro Slides | 7456 | `/pro-slides/` |

---

## 二、安装和部署 LaboFlow

本章节详细介绍如何通过 Docker 在服务器或 NAS 上部署 LaboFlow。Docker 部署是目前推荐的安装方式，适用于快速体验和生产环境。

### 2.1 环境要求

在开始部署之前，请确保你的设备满足以下条件：

| 要求 | 说明 |
|------|------|
| **操作系统** | Linux（推荐 Ubuntu 20.04+ / Debian 11+）、macOS、Windows（WSL2） |
| **Docker** | 20.10+ |
| **Docker Compose** | 2.0+（支持 `include` 指令） |
| **Git** | 用于拉取项目代码 |

**硬件配置建议：**

| 使用场景 | CPU | 内存 | 磁盘 |
|---------|-----|------|------|
| 完整体验（1-2 个 Agent） | 4 核 | 8 GB | 40 GB |
| 小团队（3-5 个 Agent） | 4-8 核 | 8-16 GB | 80 GB |
| 生产环境 | 8+ 核 | 16+ GB | 100+ GB |

### 2.2 Docker 部署步骤

**第一步：获取项目代码**

打开终端，执行以下命令将项目代码克隆到本地：

```bash
git clone https://github.com/lancelee723/LaboFlow.git
cd LaboFlow
```

> 如果克隆速度较慢，可使用浅克隆（仅获取最新版本）：
> ```bash
> git clone --depth 1 https://github.com/lancelee723/LaboFlow.git
> ```

**第二步：创建并编辑环境变量文件**

项目提供了环境变量模板文件，需要将其复制为实际使用的 `.env` 文件：

```bash
cp .env.example .env
cp WeKnora/.env.example WeKnora/.env
```

然后编辑这两个文件，填入必要的配置信息（详见下方 [2.3 环境变量配置说明](#23-环境变量配置说明)）。

**第三步：生成安全密钥**

JWT 密钥是 LaboFlow 统一认证（SSO）的基础，必须生成一个安全的随机密钥。执行以下命令生成：

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

将生成的字符串同时填入 `.env` 文件的 `JWT_SECRET_KEY` 和 `WeKnora/.env` 文件的 `JWT_SECRET`，二者必须保持一致。

此外，`SYSTEM_AES_KEY` 用于加密存储敏感的 API 密钥等信息，也需要生成：

```bash
openssl rand -base64 32 | cut -c1-32
```

将生成的 32 位字符串填入 `.env` 的 `SYSTEM_AES_KEY`。

**第四步：启动服务**

```bash
docker compose up -d
```

首次启动时，Docker 会自动拉取所需的镜像（包含全部模块：Clawith + WeKnora + PPT-Master + Pro Slides）。启动过程可能需要几分钟，请耐心等待。

**第五步：验证部署结果**

启动完成后，在浏览器中访问以下地址验证各服务是否正常运行：

- **统一入口（主页）**：`http://localhost:3008`
- **知识库**：`http://localhost:3008/kb/`
- **PPT-Master**：`http://localhost:3008/ppt-master/`

> 如果你修改了 `.env` 中 `NGINX_PORT` 的值，请将端口号替换为你自定义的端口。
> 如果你在远程服务器上部署，请将 `localhost` 替换为服务器的 IP 地址或域名。

### 2.3 环境变量配置说明

环境变量分布在两个主要文件中：根目录 `.env` 和 `WeKnora/.env`。以下是核心变量的说明。

#### 根目录 `.env` 核心变量

```bash
# ── 统一入口 ──
NGINX_PORT=3008                          # 统一访问端口
PUBLIC_BASE_URL=http://localhost:3008    # 对外访问地址（生产环境需改为实际域名）

# ── Clawith 主平台 ──
CLAWITH_FRONTEND_PORT=3080               # Clawith 前端端口
CLAWITH_BACKEND_PORT=8008                # Clawith 后端端口
JWT_SECRET_KEY=                          # JWT 密钥（必填，用于 SSO 统一认证）
JWT_ALGORITHM=HS256                      # JWT 签名算法

# ── WeKnora 知识库 ──
WEKNORA_URL=/kb                          # 知识库访问路径前缀
WEKNORA_FRONTEND_PORT=8800               # WeKnora 前端端口
SYSTEM_AES_KEY=                          # AES 加密密钥（必填，用于加密 API 密钥等敏感数据）

# ── PPT-Master ──
PPTMASTER_WEBUI_PORT=5990                # PPT-Master 前端端口
PPTMASTER_WORKER_PORT=5991               # PPT-Master 后端端口
PPTMASTER_POSTGRES_PORT=5992             # PPT-Master 数据库端口
PPTMASTER_POSTGRES_USER=pptmaster        # PPT-Master 数据库用户名
PPTMASTER_POSTGRES_PASSWORD=             # PPT-Master 数据库密码（建议修改）
PPTMASTER_POSTGRES_DB=pptmaster          # PPT-Master 数据库名称
PPTMASTER_INITIAL_ADMIN_EMAIL=           # PPT-Master 初始管理员邮箱
PPTMASTER_INITIAL_ADMIN_PASSWORD=        # PPT-Master 初始管理员密码（建议修改）
PPTMASTER_SSO_AUDIENCE=ppt-master        # SSO 认证标识

# ── 数据库（Clawith） ──
DATABASE_URL=postgresql+asyncpg://clawith:clawith@localhost:5432/clawith?ssl=disable

# ── Redis（Clawith） ──
REDIS_URL=redis://localhost:6379/0

# ── 文件存储（Clawith） ──
# 默认为本地文件系统。如需使用 S3 兼容的对象存储，请取消注释并填写以下变量：
# STORAGE_BACKEND=s3
# S3_BUCKET=
# S3_REGION=
# S3_ENDPOINT_URL=
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
```

#### `WeKnora/.env` 核心变量

```bash
# ── 数据库 ──
DB_USER=postgres
DB_PASSWORD=                              # WeKnora 数据库密码（建议修改）
DB_NAME=WeKnora

# ── Redis ──
REDIS_PASSWORD=                           # WeKnora Redis 密码（建议修改）

# ── 认证 ──
JWT_SECRET=                               # 必须与根 .env 中 JWT_SECRET_KEY 完全相同
CLAWITH_SSO_SECRET=                       # 同上，用于 Clawith SSO 跳转
SYSTEM_AES_KEY=                           # 与根 .env 中 SYSTEM_AES_KEY 相同

# ── 文档解析 ──
DOCREADER_ADDR=docreader:50051           # DocReader 服务地址
```

> **重要提醒**：`WeKnora/.env` 中的 `JWT_SECRET` 和 `CLAWITH_SSO_SECRET` 必须与根目录 `.env` 中的 `JWT_SECRET_KEY` 设置为完全相同的值，否则知识库的 SSO 单点登录将无法工作。

### 2.4 服务的启动、停止与更新

**停止所有服务：**

```bash
docker compose down
```

**更新到最新版本：**

```bash
git pull
docker compose up -d --build
```

**查看服务运行状态：**

```bash
docker compose ps
```

**查看服务日志：**

```bash
docker compose logs -f                    # 查看所有服务日志
docker compose logs -f clawith-backend    # 查看特定服务日志
```

---

## 三、快速上手

### （一）LaboFlow 主平台设置

#### 3.1 注册用户

用户注册是使用 LaboFlow 的第一步。LaboFlow 采用"首个注册用户即为平台管理员"的机制，无需额外的初始化配置。

**操作方法：**

第一步：在浏览器中访问 LaboFlow 的统一入口地址（本地部署默认为 `http://localhost:3008`），页面会自动跳转到登录页面。

第二步：在登录页面中，点击 **"注册"（Register）** 按钮，切换到注册表单。

第三步：在注册表单中填写以下信息：
- **用户名**：你的登录名称，用于在平台中显示
- **邮箱**：用于登录和接收系统通知（如密码重置）
- **密码**：设置一个安全的密码

第四步：填写完成后，点击 **"注册"** 按钮提交。系统会自动创建账户并跳转到主页。

> **重要规则**：系统中**第一个注册的用户**将自动获得**平台管理员（Platform Admin）**权限，拥有系统最高管理权限。此后注册的用户默认为**普通用户（User）**。如果后续需要将其他用户提升为管理员，可由已有管理员在"公司信息设置 → 用户管理"中进行操作。

登录后，你可以通过左侧边栏底部的用户头像区域，点击打开账户菜单，在这里可以：
- **切换语言**：支持中文和英文
- **修改账户信息**：编辑用户名、邮箱和显示名称
- **修改密码**：更改登录密码
- **切换主题**：在深色模式和浅色模式之间切换
- **退出登录**：安全退出当前账户

#### 3.2 配置模型池

LLM 模型是 Agent 得以工作的核心引擎，必须在完成模型接入之后，Agent 才能开始思考和执行任务。模型池是公司级别的共享配置，由管理员统一管理，普通用户在创建 Agent 时只能从模型池中选择已配置的模型。

**操作方法：**

第一步：使用管理员账户登录 LaboFlow。

第二步：在主页左侧边栏的顶部，点击当前公司名称，在弹出的下拉菜单中选择 **"公司信息设置"（Enterprise Settings）**。

第三步：在右侧工作区中，点击顶部的 **"模型池"（Models）** 选项卡。

第四步：点击页面中的 **"添加模型"（Add Model）** 按钮，弹出模型配置表单。

第五步：在配置表单中填写以下信息：
- **提供商（Provider）**：选择模型的服务商，如 OpenAI、Anthropic、DeepSeek 等
- **模型名称（Model Name）**：输入模型的标识符，如 `gpt-4o`、`claude-sonnet-4-6`、`deepseek-chat` 等
- **显示标签（Display Label）**：给模型取一个便于识别的名称，如"GPT-4o 主力模型"
- **API 密钥（API Key）**：输入模型服务商提供的 API 密钥
- **Base URL（基础地址）**：输入 API 的访问地址。如果使用 OpenAI 兼容协议的服务（如 DeepSeek、通义千问等），需要填写对应的基础 URL
- **最大输出 Token 数**：设置模型单次响应的最大 Token 数量
- **请求超时时间**：设置 API 调用的超时时间（秒）
- **温度（Temperature）**：控制模型输出的随机性，0 为最确定，1 为最随机
- **支持视觉识别（Supports Vision）**：如果模型具备图像识别能力（如 GPT-4o），可开启此选项

第六步：填写完成后，点击 **"测试连接"（Test Connection）** 按钮，系统会发送一个测试请求验证配置是否正确。如果测试成功，会显示成功提示和延迟时间；如果失败，请根据错误提示检查 API Key、Base URL 和模型名称是否正确。

第七步：测试通过后，点击 **"保存"（Save）** 按钮，模型即被添加到公司模型池中，可供所有用户创建 Agent 时选用。

> **建议**：优先使用兼容 OpenAI API 协议的服务（如 DeepSeek、通义千问、Kimi 等），这些服务只需填写正确的 Base URL 和 API Key 即可接入，兼容性最好。

#### 3.3 新建和配置 Agent

Agent（数字员工）是 LaboFlow 的核心工作单元。每个 Agent 拥有独立的身份、人格、记忆和工作空间，可以与人类和其他 Agent 协同完成各种任务。

**新建 Agent 的操作方法：**

第一步：在 LaboFlow 主页，你可以通过以下任一方式开始创建 Agent：
- 点击仪表盘页面的 **"新建数字员工"（Hire Agent）** 按钮
- 点击左侧边栏 Agent 列表下方的 **"+"** 按钮

第二步：系统会打开 Agent 创建向导，分为五个步骤：

**步骤一：基础信息与模型选择**

- **名称（Name）**：为 Agent 取一个名字，如"咨询助理"、"数据分析师"
- **角色描述（Role Description）**：简要描述 Agent 的职责，如"负责行业调研和竞品分析"
- **选择模板**：系统提供了预设模板（项目经理、设计师、产品实习生、市场研究员等），选择一个合适的模板可以自动填充后续步骤中的角色设定
- **选择模型**：从公司的模型池中选择一个 LLM 作为该 Agent 的主模型
- **用量限制**：设置该 Agent 每天/每月的 Token 消耗上限，防止意外超量

**步骤二：人格与边界**

- **人格设定（Personality）**：用自然语言描述 Agent 的性格、沟通风格和行为方式。例如："你是一位严谨、细致的咨询顾问，善于逻辑分析和结构化表达，回答问题时总是先给出结论再展开论证。"
- **行为边界（Boundaries）**：定义 Agent 不该做什么。例如："不要提供未经证实的医疗或法律建议；遇到不确定的信息要明确说明而非编造。"

**步骤三：技能配置**

- 勾选该 Agent 需要加载的技能模块（Skills）。公司级别的默认技能会自动勾选且不可取消。勾选的技能将在 Agent 创建后自动安装到它的工作空间中。

**步骤四：权限设置**

- **可见范围**：选择"全公司可见"、"仅自己可见"或"指定成员可见"，控制哪些用户可以查看和使用该 Agent
- **权限级别**：选择"使用权限"（可对话、分配任务）或"管理权限"（可修改 Agent 的全部设置）

**步骤五：渠道配置**

- 选择 Agent 接入的即时通讯渠道（飞书、Slack、Discord 等），填写对应的 App ID、App Secret 等认证信息。如果暂时不需要，可以跳过此步骤，创建完成后随时再配置。

第三步：确认所有配置无误后，点击 **"创建"（Create）** 按钮，Agent 即被创建并出现在左侧边栏的 Agent 列表中。

---

**配置 Agent 的详细设置：**

创建完成后，点击 Agent 进入其专属页面，顶部有一排选项卡，每个选项卡对应一组配置功能：

**（1）Chat（聊天）选项卡**

这是与 Agent 交互的主界面。在对话框输入你的问题或任务描述，Agent 会实时响应。对话支持：
- Markdown 格式的富文本渲染
- 代码语法高亮
- 文件附件上传
- 会话管理（新建、切换、删除会话）

**（2）Status（状态）选项卡**

展示 Agent 的运行统计数据，包括：
- 过去 24 小时的操作次数
- 今日 LLM 调用次数
- 累计 Token 消耗量
- 待处理的 Focus Items 数量

**（3）Aware（自我意识）选项卡**

这是 Agent 自主意识系统的控制面板：
- **Focus Items**：Agent 的结构化工作记忆，分为待办（Todo）、进行中（In Progress）和已完成（Done）三种状态
- **Standalone Triggers（独立触发器）**：配置 Agent 自动执行的触发条件，支持六种类型：
  - `cron`：定时触发（如每天 9 点执行日报）
  - `once`：单次定时触发
  - `interval`：间隔触发（如每 30 分钟检查一次）
  - `poll`：HTTP 轮询触发
  - `on_message`：收到消息时触发
  - `webhook`：外部事件通过 Webhook 触发
- **Reflections（内心独白）**：Agent 自我反思的记录
- **Task History**：已执行任务的完整历史

**（4）Mind（心智）选项卡**

Agent 的核心心智配置，包含：
- **soul.md**：Agent 的性格定义文件，用 Markdown 编辑
- **memory.md**：Agent 的长期记忆，记录重要的经验和信息
- **heartbeat.md**：心跳指令文件，定义 Agent 在每次心跳时需要思考和检查的事项
- **memory 目录**：其他记忆文件

**（5）Tools（工具）选项卡**

管理 Agent 可用的 MCP 工具：
- **系统预置工具**：平台默认提供的标准工具（文件读写、网络搜索、代码执行等）
- **公司工具**：管理员在"公司信息设置 → 工具"中配置的工具
- **自安装工具**：Agent 自主搜索并安装的工具（来自 Smithery 或 ModelScope 市场）
- 每个工具可以单独开启/关闭，也可以覆盖默认配置（如 API Key）

**（6）Skills（技能）选项卡**

管理 Agent 已安装的技能。每个技能是一个包含 `SKILL.md` 文件的文件夹，定义了 Agent 执行某类任务的方法和流程。你可以：
- 查看已加载的技能列表和内容
- 从 GitHub URL 导入新技能
- 从 ClawHub 市场浏览和安装技能
- 创建全新的自定义技能

**（7）Relationships（关系）选项卡**

定义 Agent 与组织内外成员的协作关系：
- **人类关系**：搜索并添加组织成员，为每个人定义协作角色（如"主管"、"同事"、"下属"、"利益相关者"等），Agent 会根据这些关系决定何时找谁协作
- **Agent 关系**：添加其他 Agent 作为协作者，定义它们之间的分工和协作方式

**（8）Workspace（工作区）选项卡**

Agent 的私有文件工作空间，支持：
- 文件和文件夹的创建、上传、编辑、删除
- 文件版本历史查看
- 代码文件的沙盒化执行
- 文件预览和新标签页打开

**（9）Activity Log（工作日志）选项卡**

Agent 的完整活动记录，可按类型筛选：
- 用户操作
- 后台服务操作
- 定时/计划任务
- 消息记录

**（10）Approvals（审批）选项卡**

当 Agent 执行需要审批的危险操作（如删除文件）时，审批请求会出现在这里。管理员可以批准或拒绝每个请求。

**（11）Settings（设置）选项卡**

Agent 的核心配置面板：
- **模型配置**：选择主模型、备用模型，设置对话上下文窗口大小和工具调用轮次上限
- **Token 限额**：设置每日/每月 Token 用量上限，查看当前消耗
- **自主性边界**：为不同类型操作设置自主权限级别：
  - L1 自动执行：Agent 无需通知即可执行（如读取文件）
  - L2 通知执行：Agent 执行后通知用户（如写入文件）
  - L3 需审批：Agent 必须获得人工批准方可执行（如删除文件）
- **触发器限制**：设置最大触发器数量、最小轮询间隔、Webhook 速率限制
- **心跳（Heartbeat）**：开启或关闭心跳功能，设置心跳间隔和工作时段（如仅在 9:00-18:00 工作）
- **时区**：设置 Agent 的时区（用于定时任务的基准时间）
- **渠道配置**：配置飞书/Slack/Discord/Web 等通信渠道
- **欢迎消息**：设置用户在网页端首次进入对话时看到的欢迎语
- **Agent 有效期**：设置 Agent 的到期时间，到期后 Agent 将自动暂停
- **删除 Agent**：在"危险区"中可以删除该 Agent（需输入 Agent 名称确认）

**（12）Tasks（任务）选项卡**

Agent 的看板式任务管理，分为四列：
- **Todo（待办）**：等待开始的任务
- **In Progress（进行中）**：正在执行的任务
- **Supervision（监督中）**：需要人工关注的任务
- **Done（已完成）**：已完成的任务

创建新任务时，可以设置标题、描述、截止日期、定时计划（cron 表达式）和优先级（低/中/高/紧急）。

#### 3.4 安装技能（Skills）

技能（Skills）是 Agent 可以学习和执行的标准化能力模块。每个技能本质上是一个包含 `SKILL.md` 定义文件的文件夹，它告诉 Agent"面对某类任务时，应该按照什么方法和步骤来执行"。例如，你可以安装一个"竞品分析"技能，让 Agent 学会如何系统地完成竞品分析报告。

**技能管理概述：**

技能有两个管理层面：
1. **公司级别技能**（在"公司信息设置 → 技能"中管理）：由管理员添加的技能会自动集成到所有新创建的 Agent 中
2. **Agent 级别技能**（在 Agent 的"Skills"选项卡中管理）：每个 Agent 可以单独安装、管理和删除技能

**技能来源：**

- **[ClawHub.ai](https://clawhub.ai)**：官方的技能市场，提供各类经过验证的社区技能，涵盖行业分析、报告撰写、数据处理等领域
- **GitHub 仓库**：你可以直接输入一个包含技能文件夹的 GitHub URL 来导入技能
- **自行创建**：你可以在 Agent 的 Skills 选项卡中直接创建新的技能文件

---

**安装技能的操作方法：**

**方式一：从公司技能库安装到 Agent（推荐）**

第一步：使用管理员账户登录，进入 **"公司信息设置"→"技能"（Skills）** 选项卡。

第二步：点击 **"浏览技能"（Browse Skills）** 按钮，系统会打开 ClawHub 技能市场浏览器。

第三步：在市场中找到你需要的技能，查看其名称、图标和功能描述，点击 **"导入"（Import）** 按钮将其添加到公司技能库。

第四步：公司技能库中的技能会自动出现在所有新建 Agent 的创建向导中（步骤三"技能配置"）。对于已创建的 Agent，进入 Agent 的 **"Skills"** 选项卡，从可用技能列表中勾选需要的技能即可。

**方式二：直接为特定 Agent 安装技能**

第一步：进入目标 Agent 的页面，点击顶部的 **"Skills"（技能）** 选项卡。

第二步：点击 **"导入技能"（Import Skill）** 按钮，在弹出的对话框中：
- 选择 **"从 ClawHub 安装"**：浏览技能市场，选择并导入
- 选择 **"从 GitHub URL 安装"**：输入包含技能文件夹的 GitHub 仓库地址，点击导入

第三步：技能导入成功后，Agent 即刻获得该技能定义的能力，你可以在 Skills 列表中查看和编辑技能文件的内容。

**方式三：自行创建技能**

第一步：在 Agent 的 **"Skills"** 选项卡中，点击 **"新建技能"** 按钮。

第二步：输入技能名称（将作为文件夹名称），选择存储格式（单文件或文件夹格式）。

第三步：编辑 `SKILL.md` 文件，按照 Skill 协议编写技能的触发条件、执行步骤和输出规范。

第四步：保存后，技能即刻生效。

---

**删除技能的操作方法：**

第一步：在"公司信息设置 → 技能"页面或 Agent 的 Skills 选项卡中找到要删除的技能。

第二步：点击技能卡片上的 **"删除"（Delete）** 按钮，系统会弹出确认对话框。

第三步：确认删除后，该技能将从对应的技能库中移除。注意，删除公司技能不会自动移除已安装到 Agent 中的副本。

#### 3.5 配置工具（MCP）

在 LaboFlow 中，**"工具"（Tools）**是指基于 MCP（Model Context Protocol）协议的标准化服务接口。通过 MCP，Agent 可以调用外部服务——例如读写文件、搜索网络、执行代码、发送邮件、操作浏览器等——从而扩展其能力边界。

**工具管理概述：**

工具有三个层级：
1. **系统预置工具**：平台默认提供的标准工具集，对所有 Agent 自动可用
2. **公司级别工具**：在"公司信息设置 → 工具"中配置，供全公司的 Agent 使用
3. **Agent 自安装工具**：Agent 在执行任务时自主搜索并安装的 MCP 工具（来自 Smithery 或 ModelScope 市场）

---

**配置公司级别 MCP 工具的操作方法：**

第一步：使用管理员账户登录，进入 **"公司信息设置"→"工具"（Tools）** 选项卡。

第二步：页面顶部有两个子选项卡：
- **"全局工具"（Global Tools）**：管理和配置平台预置的工具
- **"Agent 已安装"（Agent Installed）**：查看各 Agent 自行安装的工具

第三步：在"全局工具"页面中，点击 **"添加 MCP 服务"** 按钮。

第四步：在弹出的配置表单中填写以下信息：
- **服务名称（Name）**：给工具取一个识别名称
- **服务 URL（Server URL）**：MCP 服务的访问地址
- **API Key**：如果服务需要认证，填写 API 密钥
- **配置参数（Configuration）**：以 JSON 格式输入服务的额外配置参数

第五步：点击 **"测试连接"** 按钮验证服务是否可用，然后点击 **"保存"**。

第六步：配置完成后，该工具将出现在所有 Agent 的 Tools 选项卡中，Agent 可以在执行任务时调用它。

---

**为特定 Agent 配置工具权限的操作方法：**

第一步：进入目标 Agent 的页面，点击顶部的 **"Tools"（工具）** 选项卡。

第二步：在工具列表中，找到你想要管理的工具。每个工具卡片上都有一个**启用/禁用开关**，点击开关可以控制该工具是否对该 Agent 可用。

第三步：如果某个工具需要 Agent 使用独立的 API Key 或不同的配置参数，可以点击工具卡片上的 **"配置"（Configure）** 按钮，输入覆盖配置。勾选覆盖后，该 Agent 将使用自己的配置而非全局默认配置。

> **建议**：对于知识库 MCP 工具（knowledge），推荐采用"全局配置一个知识库 API + 每个 Agent 单独开启知识库 MCP 功能"的方式，既避免了重复配置，又能灵活控制各 Agent 对知识库的访问权限。具体配置方法请参见[第 3.10 节](#310-将知识库-api-分享到-laboflow)。

---

### （二）知识库模块（WeKnora）

#### 3.6 登录知识库

在 LaboFlow 中，知识库模块通过 SSO 单点登录与主平台打通，你无需单独注册或登录知识库。

**操作方法：**

第一步：确保你已登录 LaboFlow 主平台。

第二步：在 LaboFlow 主页的左侧边栏中，点击 **"知识库"（Knowledge Base）** 按钮。

第三步：系统会自动通过 SSO 跳转到 WeKnora 知识库页面，你将以与 LaboFlow 相同的身份进入知识库。无需再次输入用户名和密码。

> 如果跳转失败，请检查 `WeKnora/.env` 中的 `JWT_SECRET` 和 `CLAWITH_SSO_SECRET` 是否与根目录 `.env` 中的 `JWT_SECRET_KEY` 完全一致。

#### 3.7 创建知识库

知识库是 WeKnora 中存储和组织文档的基本单元。每个知识库可以独立配置解析策略、检索方式和存储后端。

**操作方法：**

第一步：在 WeKnora 主页（即知识库列表页面），点击 **"创建知识库"（Create Knowledge Base）** 按钮。

第二步：在弹出的创建对话框中填写以下信息：
- **名称**：为知识库取一个有意义的名字，如"客户案例库"、"行业研究报告"
- **描述**：简要说明知识库的内容和用途
- **知识库类型**：选择以下三种类型之一：
  - **文档（Document）**：适合存储和检索各类文档内容
  - **FAQ**：适合构建问答对形式的知识库
  - **Wiki**：适合构建结构化的知识体系，Agent 可自动维护

第三步：点击 **"创建"** 按钮，知识库即创建完成并出现在列表中。

---

**上传文档的操作方法：**

第一步：在知识库列表中点击目标知识库，进入其详情页面。

第二步：在详情页的 **"文档"（Documents）** 选项卡中，点击 **"上传"（Upload）** 按钮，你可以选择：
- **上传文件**：从本地选择文件，支持 PDF、Word（DOCX）、Excel（XLSX）、PPT（PPTX）、Markdown、TXT、CSV、JSON、图片等十余种格式
- **添加 URL**：输入网页地址，系统会自动抓取网页内容
- **从数据源导入**：如果管理员已配置飞书/Notion/语雀等数据源，可从中导入文档

第三步：选择文件后，弹出 **"上传确认"** 对话框。你可以在此为这批文档配置处理参数：
- **解析器（Parser）**：选择默认的 DocReader 解析器或 MinerU（适合复杂排版的 PDF）
- **分块策略（Chunking）**：设置文档切分的方式和大小
- **多模态处理**：是否提取文档中的图片并进行 OCR 识别
- **知识图谱提取**：是否自动从文档中抽取实体和关系
- **问题生成**：是否自动为文档内容生成问答对

第四步：确认设置后，点击 **"开始处理"**。系统会异步处理文档，你可以在文档列表中看到每份文档的处理进度和最终状态（成功/失败）。处理完成后，文档状态会更新为"可检索"。

> **提示**：文档处理是异步进行的，你不需要保持页面停留。可以关闭页面稍后回来查看处理结果。

#### 3.8 分享知识库

共享知识库可以让团队中的其他成员共同查看和使用知识库的内容。WeKnora 支持基于角色的精细权限控制。

**操作方法：**

第一步：在知识库详情页面中，点击右上角的 **"设置"（Settings）** 按钮进入知识库设置。

第二步：在设置菜单中找到 **"共享"（Share）** 选项卡。

第三步：在共享设置页面中，你可以：
- **添加成员**：搜索并添加组织内的成员
- **设置角色**：为每个成员分配角色，WeKnora 支持四种角色级别：
  - **Owner（所有者）**：拥有知识库的完全控制权
  - **Admin（管理员）**：可以管理文档、配置和成员
  - **Contributor（贡献者）**：可以上传和编辑文档
  - **Viewer（查看者）**：只能查看和检索文档内容
- **设置为公开**：如果希望全公司成员都能访问，可以开启公开访问

第四步：点击 **"保存"**，团队成员即可按照各自权限访问该知识库。

> **提示**：知识库共享是基于角色级别的权限控制，确保敏感信息只对授权人员可见。

#### 3.9 配置 LLM 模型

在 WeKnora 中配置 LLM 模型是知识库问答和 Agent 检索功能的基础。WeKnora 需要配置五种类型的模型：对话/知识问答模型（Chat/KnowledgeQA）、Embedding 嵌入模型、Rerank 重排模型、VLLM 多模态视觉模型、ASR 语音识别模型。

**重要提示**：根据 WeKnora 的权限设计，**每名用户自行配置的 LLM 只能由配置者自己看到和使用**，其他用户（包括管理员）无法查看或使用你配置的模型。如果希望所有用户都能使用某些模型，需要由管理员配置**内置模型（Built-in Models）**。

---

**方式一：管理员配置内置模型（推荐，对所有用户可见）**

内置模型对所有租户可见且只读，API 密钥等敏感信息被隐藏。配置方法请参考 WeKnora 官方文档：

👉 [https://github.com/Tencent/WeKnora/blob/main/docs/BUILTIN_MODELS.md](https://github.com/Tencent/WeKnora/blob/main/docs/BUILTIN_MODELS.md)

内置模型支持两种添加方式：
1. **YAML 声明（推荐）**：编辑 `config/builtin_models.yaml`，支持使用 `${ENV_VAR}` 引用环境变量
2. **SQL 直接插入**：向 `models` 表的 `is_builtin` 字段设置为 `true`

---

**方式二：个人用户配置自己的 LLM**

第一步：在 WeKnora 页面中，点击左侧边栏底部的 **"设置"（Settings）** 按钮。

第二步：在设置页面左侧导航中，找到 **"模型与运行时"** 分组，点击 **"模型管理"（Model Management）**。

第三步：在模型管理页面顶部，你可以看到五个模型类型的选项卡：
- **Chat / KnowledgeQA**：对话和知识问答模型（核心，必配）
- **Embedding**：嵌入模型，用于将文本转换为向量（核心，必配）
- **Rerank**：重排模型，用于对检索结果进行二次排序（推荐配置）
- **VLLM**：多模态视觉模型，用于理解图片内容
- **ASR**：语音识别模型，用于语音输入

第四步：切换到需要配置的模型类型选项卡，点击 **"添加模型"（Add Model）** 按钮。

第五步：在弹出的对话框中填写模型信息：
- **提供商（Provider）**：选择模型服务商
- **模型名称（Model）**：输入模型标识符
- **API Key**：输入 API 密钥
- **Base URL**：输入 API 基础地址
- **是否设为默认**：如果是主要使用的模型，可设为默认

第六步：点击 **"保存"**，模型即配置完成。配置后的模型仅对你个人可见。

> **注意**：至少需要配置一个 Chat/KnowledgeQA 模型和一个 Embedding 模型，知识库的检索和问答功能才能正常工作。

#### 3.10 将知识库 API 分享到 LaboFlow

通过 MCP 协议将 WeKnora 知识库的 API 接入 LaboFlow，可以让 LaboFlow 的 Agent 直接搜索和读取知识库中的内容。这是连接"数字员工"和"企业知识"的关键步骤。

**建议的配置策略**：采用"全局配置一个知识库 API + 每个 Agent 单独开启知识库 MCP 功能"的方式。这样既避免了为每个 Agent 重复配置 API 的繁琐，又能通过 Agent 级别的开关灵活控制哪些 Agent 可以访问知识库。

**操作方法：**

**第一步：在 WeKnora 中获取 API Key**

1. 在 WeKnora 页面中，点击左侧边栏底部的 **"设置"（Settings）** 按钮
2. 在设置页面的左侧导航中，点击 **"API 信息"（API）**（位于"账户"分组下）
3. 在 API 信息页面中，你将看到：
   - **API Key**：默认以星号遮盖，点击"显示"按钮可查看完整密钥，点击"复制"按钮可复制到剪贴板
   - **API Base URL**：API 的基础访问地址
4. 点击 **"复制"** 按钮获取 API Key。如果尚未生成 API Key 或需要重置，点击"重新生成"按钮（注意：重置后旧 Key 将立即失效）

**第二步：在 LaboFlow 中配置知识库工具**

1. 返回 LaboFlow，使用管理员账户进入 **"公司信息设置"→"工具"（Tools）** 选项卡
2. 在工具列表中找到名为 **"knowledge"（知识库）** 的工具
3. 点击该工具卡片上的 **"配置"（Configure）** 按钮
4. 在弹出的配置表单中输入从 WeKnora 获取的 **API Key** 和 **API Base URL**
5. 点击 **"测试连接"** 确认配置正确，然后点击 **"保存"**
6. 确保 knowledge 工具的全局开关处于**启用**状态

**第三步：为 Agent 开启知识库访问权限**

1. 进入目标 Agent 的页面，点击顶部的 **"Tools"（工具）** 选项卡
2. 在工具列表中找到 **"knowledge"** 工具
3. 将工具开关切换为**启用**状态

完成以上配置后，该 Agent 即可在执行任务时自动搜索和引用知识库中的文档内容。如果某个 Agent 不需要访问知识库（例如它只负责外部信息收集），只需在第三步中关闭 knowledge 工具即可。

---

### （三）PPT-Master WebUI 模块

#### 3.11 登录 PPT-Master

PPT-Master WebUI 是 LaboFlow 的新版 AI PPT 生成器，通过 SSO 单点登录与主平台打通。

**操作方法：**

第一步：确保你已登录 LaboFlow 主平台。

第二步：在 LaboFlow 主页的左侧边栏中，点击 **"PPT Master"** 按钮。

第三步：系统会自动通过 SSO 跳转到 PPT-Master 页面。首次登录时，PPT-Master 会使用你在 LaboFlow 的身份信息自动创建账户。

#### 3.12 配置模型

PPT-Master 需要 LLM 模型来驱动 PPT 的各个生成环节。PPT-Master 支持多种角色的模型配置，不同环节可以使用不同的模型以优化成本和质量。

**操作方法：**

第一步：在 PPT-Master 页面中，点击左侧边栏的 **"Settings"（设置）** 菜单项。

第二步：在设置页面中点击 **"LLM Providers"（LLM 提供商）** 选项卡。

第三步：点击 **"Add Provider"（添加提供商）** 按钮，在弹出的对话框中填写：
- **提供商（Provider）**：支持 Anthropic（Claude）、OpenAI（GPT）、Google（Gemini）、DeepSeek、Qwen（通义千问/DashScope）、Ollama（本地）、vLLM、Zhipu（智谱 GLM）、Kimi（Moonshot）、MiniMax、Baidu（百度千帆）、OpenRouter 等
- **模型（Model）**：输入模型名称
- **API Key**：输入 API 密钥
- **Endpoint（端点）**：如使用自定义端点，在此填写 Base URL
- **角色偏好（Role Preference）**：选择该模型擅长的角色：
  - All roles（全部角色）：适用于所有环节
  - Strategist（策略师）：擅长策略设计和创意构思
  - Image Generator（图片生成）：用于 AI 配图
  - Executor（执行器）：用于逐页生成 PPT 内容
  - Template Picker（模板选择）：用于匹配合适的模板

第四步：点击 **"Test"（测试）** 按钮验证连接。测试成功后会显示延迟时间。

第五步：如果你想将某个模型作为某类任务的首选，勾选 **"Set as Default"（设为默认）**。点击 **"Save"** 完成配置。

第六步（可选）：你还可以配置以下辅助服务：
- **Image Backends（图片生成后端）**：配置 AI 图片生成服务，用于为 PPT 配图
- **Image Search（图片搜索）**：配置图片搜索引擎（Pexels、Pixabay），用于从网络中查找配图。注意：Openverse 和 Wikimedia Commons 是零配置的，始终可用

#### 3.13 开始制作 PPT

PPT-Master 采用管线式设计，将 PPT 制作过程分为七个步骤，每一步都有清晰的输入和输出。整个流程由 LangGraph 驱动，你只需要在关键的决策点提供输入，其余环节由 AI 自动完成。

**完整的操作流程：**

**第零步：创建新项目**

1. 在 PPT-Master 首页（项目列表页面），点击 **"New Project"（新项目）** 按钮
2. 进入项目初始化页面，填写以下内容：
   - **项目名称**：给项目起一个名字
   - **项目简述（Brief）**：用自然语言描述你想要的 PPT 内容、主题和大致方向。例如："制作一份关于 2024 年中国新能源汽车市场的分析报告，涵盖市场规模、竞争格局、技术趋势和未来展望"
   - **上传素材（可选）**：如果有参考资料，可以上传 PDF、DOCX、XLSX、PPTX、MD、TXT 文件或粘贴网页链接
   - **选择 LLM 模型**：从已配置的模型中选择一个用于本次生成
   - **生成演讲者备注（Speaker Notes）**：根据需要选择是否生成备注

3. 点击 **"Start"（开始）**，进入管线流程

**第一步：素材处理（Source Processing）**

系统自动将你上传的素材文件转换为 Markdown 文本。这一步不需要你操作，系统会显示每份文件的处理结果（成功/失败）。确认无误后，点击 **"Confirm"（确认）** 进入下一步。

**第二步：模板选择（Template Selection）**

系统会展示可用的 PPT 模板，你可以：
- 选择一个预设模板（类型包括：版式模板 `layout`、套件模板 `deck`、品牌模板 `brand`）
- 选择 **"Free Design"（自由设计）**，不依赖模板，让 AI 从头设计
- 你也可以上传自己的 PPTX 文件作为模板

点击选中的模板，然后确认继续。

**第三步：策略设计（Strategy）**

这是最关键的步骤，系统会依次弹出多个配置面板，让你为 PPT 设定设计策略。全部配置完成后才会进入下一步。

- **Canvas Format（画布格式）**：选择画布比例和类型——PPT 16:9（横屏演示）、PPT 4:3（传统投影）、小红书（竖屏图文）、Square（正方形）、Vertical（竖版）等

- **Page Count（页数）**：指定 PPT 的总页数，或选择"让 AI 根据素材内容自动决定"

- **Target Audience（目标受众）**：选择受众类型（高管、管理者、投资者、技术人员、普通大众等），填写演讲场合（如"内部汇报"、"投资人路演"、"客户提案"）和核心要传达的信息

- **Style Objective（风格目标）**：选择沟通模式和视觉风格：
  - 沟通模式：Versatile（通用）、Consulting（咨询风格）、Top Consulting（顶级咨询风格）
  - 视觉风格描述：用自然语言描述你期望的视觉效果，如"简洁专业，蓝色调，数据驱动"

- **Color Scheme（配色方案）**：AI 会根据你的风格目标自动推荐配色，你可以编辑各颜色的 HEX 值，也可以从预设色板中选择

- **Icon Usage（图标使用）**：选择图标库（Chunk Filled / Tabler Filled / Tabler Outline / Phosphor Duotone），设置图标描边粗细和允许使用的图标范围

- **Typography Plan（字体方案）**：选择标题字体、正文字体和代码字体，设置正文字号，选择公式渲染方式

- **Image Strategy（配图策略）**：选择默认的配图来源——AI 生成、网络搜索、用户提供、占位图。你也可以为特定页面单独设置不同的配图策略

**第四步：预检确认（Preflight Review）**

系统会展示一个完整的配置摘要，包括：项目简述、模板、画布格式、页数、配色、字体、图标、配图策略和页面大纲。请仔细审查所有设置是否正确。

确认无误后，勾选 **"I have reviewed all settings"（我已审查所有设置）**，然后点击 **"Start Generating PPT"（开始生成 PPT）**。

如果你发现页数需要调整，可以在此步骤修改页数，系统会自动重新规划页面大纲。

**第五步：SVG 逐页生成（Generate）**

系统开始逐页生成 PPT。每页会：
1. 根据页面大纲和素材内容构建页面提示词
2. 调用 LLM 生成 SVG 格式的页面
3. 自动验证 SVG 格式的正确性
4. 对不合格的页面自动重试

你可以在页面上实时看到每页的生成进度。如果启用了演讲者备注，系统会在所有页面生成后自动生成备注内容。

**第六步：导出（Export）**

所有页面生成完成后，系统会自动将 SVG 转换为 PPTX 格式。你可以在 **"Exports"** 面板中下载生成的 PPTX 文件。

**额外功能：**

- **模板管理**：在左侧边栏点击 **"Templates"** 进入模板管理页面，你可以上传自己的 PPTX 模板，配置模板的品牌信息（Logo、配色、字体等）
- **用量统计**：在设置页面点击 **"Usage"** 查看 Token 使用情况和历史记录

---

## 四、本地开发

本地开发模式适用于需要对 LaboFlow 进行二次开发、功能调试或自定义修改的场景。开发模式支持所有服务的热重载（Hot Reload），修改代码后无需重启即可看到效果。

### 4.1 前置要求

在开始本地开发之前，请确保你的开发环境中已安装以下工具：

| 工具 | 最低版本 | 安装方式（macOS） |
|------|---------|------------------|
| Python | 3.12+ | `brew install python@3.12` |
| Node.js | 20+ | `brew install node` |
| pnpm | 最新 | `npm install -g pnpm` |
| uv | 最新 | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Go | 1.23+ | `brew install go` |
| nginx | 最新 | `brew install nginx` |
| Docker & Docker Compose | 最新 | Docker Desktop |

### 4.2 初始化项目

**第一步：创建环境变量文件**

```bash
cd LaboFlow
cp .env.example .env
cp WeKnora/.env.example WeKnora/.env
```

**第二步：生成密钥并填入 `.env`**

生成 JWT 密钥：
```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

将生成的字符串同时填入 `.env` 的 `JWT_SECRET_KEY` 和 `WeKnora/.env` 的 `JWT_SECRET`。

**第三步：安装所有依赖**

```bash
./setup-all.sh
```

`setup-all.sh` 脚本会按顺序完成以下操作：
1. 检查系统工具（nginx、uv、pnpm、python3）是否已安装
2. Clawith：安装 Python 虚拟环境、Node 依赖、配置 PostgreSQL
3. WeKnora：准备 `.env`、启动开发依赖容器（postgres/redis/docreader）、安装前端依赖
4. AIPPT：使用 `pnpm install` 安装前端依赖

### 4.3 启动开发环境

```bash
./dev.sh
```

启动成功后，终端会显示如下信息：

```
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

### 4.4 停止服务与查看日志

```bash
./stop.sh                   # 停止所有开发服务
tail -f .data/log/*.log     # 实时查看所有服务日志
```

### 4.5 常见故障排查

| 问题 | 解决方案 |
|------|----------|
| 端口被占用 | 运行 `./stop.sh` 清理端口；仍占用可手动 `lsof -i:3008` 查看占用进程 |
| NGINX 启动失败 | 检查 `include /etc/nginx/mime.types` 路径是否正确 |
| WeKnora 启动失败 | 查看 `.data/log/weknora-app.log` 和 `.data/log/weknora-infra.log` |
| WeKnora 文档解析失败 | 确认开发依赖容器已启动：`docker compose -f WeKnora/docker-compose.dev.yml -f docker-compose.dev-override.yml ps` |
| AIPPT 子路径 404 | 确保 `VITE_BASE=/ppt/` 环境变量已正确传入 |
| Clawith 数据库连接失败 | 确认本机 PostgreSQL 已启动，且 `.env` 中 `DATABASE_URL` 配置正确 |
| WeKnora 数据库连接失败 | 开发模式下 WeKnora 默认连接 `localhost:5433`，确认开发依赖容器已正常启动 |

---

## 五、其它提示

### 5.1 在飞牛 OS 中部署 LaboFlow

#### （1）使用飞牛 Docker 管理器部署的配置调整

飞牛 OS（FNOS）的 Docker 管理器不支持 Docker Compose 标准的 `include` 指令（用于引入和覆盖外部 compose 文件）。因此，LaboFlow 为飞牛 OS 提供了专用的、完全内联的 Compose 文件：**`docker-compose-fnos.yml`**。

使用飞牛 Docker 管理器部署时，请按照以下步骤操作：

第一步：将项目代码上传到飞牛 NAS。

第二步：**不使用标准的 `docker-compose.yml`**，而是使用飞牛专用版本：

```bash
cp .env.example .env
# 编辑 .env，填入必要的配置信息
docker compose -f docker-compose-fnos.yml up -d
```

第三步（关键）：在飞牛 Docker 管理器的环境变量设置中，确保以下变量已正确配置：

| 变量 | 说明 | 示例 |
|------|------|------|
| `JWT_SECRET_KEY` | 长度 ≥32 的随机字符串，三方 SSO 共享密钥 | `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'` |
| `SYSTEM_AES_KEY` | 32 字节 AES 加密密钥 | `openssl rand -base64 32 \| cut -c1-32` |
| `SECRET_KEY` | Clawith 后端密钥 | 任意长度的随机字符串 |
| `REGISTRY` | 镜像仓库地址（默认指向作者阿里云仓库） | `crpi-oxztsn6qggvtnlnf.cn-guangzhou.personal.cr.aliyuncs.com/laboflow` |
| `TAG` | 镜像版本标签 | `latest` |

`docker-compose-fnos.yml` 与标准 `docker-compose.yml` 的主要区别：
- **无 `include` 指令**：所有 WeKnora 服务（app、docreader、frontend、postgres、redis、sandbox）均已内联
- **覆盖的服务已合并**：LaboFlow 对 WeKnora 的定制修改（SSO 支持、自定义前端 base path 等）已直接内联到对应服务定义中
- **Pro Slides 使用预构建镜像**：不执行本地构建，直接从镜像仓库拉取

#### （2）通过 FN Connect 进行内网穿透的注意事项

如果你使用飞牛 OS 的 **FN Connect** 功能进行内网穿透（即在外网通过 FN Connect 访问 NAS 上的服务），请注意以下操作顺序：

**必须先通过 FN Connect 登录飞牛 NAS，再访问 LaboFlow 服务。**

原因：飞牛 OS 的安全机制会拦截未经 NAS 认证的直接访问。正确的访问流程如下：

第一步：在外网环境下，通过 FN Connect 客户端或飞牛 App 连接到你的飞牛 NAS。

第二步：完成 NAS 的身份认证后，在浏览器中访问 LaboFlow 的统一入口地址（通过 FN Connect 提供的域名或 IP）。

第三步：此时你可以正常登录和使用 LaboFlow 的全部功能。

> 如果直接打开 LaboFlow 服务地址而未先通过 FN Connect 登录 NAS，访问请求会被飞牛的拦截机制阻挡，导致无法打开页面。

---

*本手册最后更新于 2026 年 7 月。LaboFlow 持续迭代中，请关注项目仓库获取最新信息。*
