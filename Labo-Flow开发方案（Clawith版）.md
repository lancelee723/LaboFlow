# 询行业AI工作台（Labo-Flow）开发方案

【核心提示】这是一份面向咨询行业的AI工作台的产品开发方案。产品暂定命名为：Labo-Flow



## 一、用户需求

### 1.客户背景

用户是一家大型管理咨询公司，有超过300名专业的咨询顾问。主要承接国有企业的战略规划、人力资源、企业文化、组织管控、数字化转型等项目。
咨询业务的流程大体上包括以下几个环节：

| 阶段     | 工作内容                                                     | 核心痛点                                                     |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 前端销售 | 有两种情形：一是初次触达客户时，会根据客户提供的简要的项目需求，准备一份针对性的沟通材料（PPT形式），内容主要是对客户基本情况的分析、需求的理解和解决方案、同类型项目的案例等，初次沟通PPT材料往往有70页左右；二是进入投标阶段，需要根据前期与客户沟通交流得到的详细需求，以及项目招标说明书中对于项目需求、报价、服务等的要求制作详细的投标版项目建议书，这份建议书往往有100页左右 | 时间紧：往往只有几天的时间去准备初次沟通材料，或者1-2周的时间准备建议书<br />信息盲盒：前期对客户的情况了解不多，能够找到的公开资料都比较分散或稀少 |
| 调研诊断 | 项目启动前期，项目组以团队形式开展调研诊断，目的是了解企业现状、找到本次项目需要解决的核心问题。调研的方法包括人员访谈、资料研读和现场观察等。其中，人员访谈会针对企业高中基层人员开展专项调研访谈，并形成大量的访谈记录（比如一个战略规划规划项目需要访谈企业管理层、中层干部和部分基层员工，并形成超过10万字的访谈原始记录）；资料研读则是根据项目组提供给客户的资料需求清单，对客户的财务报表、工作总结、内部规章制度、上级或外部的领导讲话、规划意见、通知等材料进行详细研读，了解客户基本面、当前管理制度的情况；现场观察则多发生在人力资源项目中，通过劳动观察法等方式观察员工工作流程、工作量和团队配置情况。最终团队将制作一份相近的调研诊断报告，向客户管理层反馈当前存在的问题、与行业标杆进行对标分析、方案的初步思路等内容。诊断报告的主要展现形式以PPT的形式展现，完整版PPT往往有50-100页，用于向客户高管汇报的PPT简版往往有30-50页 | 时间紧、工作量大：调研诊断一般只有2-4周，团队往往要完成40+人次的访谈，还要研读资料，无法在短时间内做到细致颗粒度的调研。比如资料研读往往就无法详细开展，财报数据就不能详细分析 |
| 方案设计 | 结合前期的调研报告内容，开展项目方案设计。这一阶段项目组成员将分工协作，每个人负责一个模块的设计（以战略规划为例：有人负责内外部环境分析、有人负责总体战略设计、有负责业务板块及业务战略设计，最终合成一个完整的战略规划，并进行统一讨论）。此阶段顾问们需要开展大量的资料搜索、案例对标工作，同时还要设计故事线、内容的逻辑关系，并最终以PPT的形式展现给客户。这份方案设计展现的形式包括PPT和Word文档，其中PPT是重要的过程和成果文件，顾问们往往先设计PPT，然后修改、汇报、定稿，再基于PPT的内容转制成Word文档 | 存在大量的信息收集、整理工作，比如外部案例、行业数据等等，需要耗费大量的人力和时间去搜集资料、研究分析<br />逻辑缜密、观点鲜明：对于成熟的咨询顾问而言做到这一点不难，但对于新顾问来说需要花费较长时间才能学习、领悟到逻辑关系如何恰当地展现于陈述是一件比较困难的事情。同时，由于是多个人分别负责不同的模块，在整合时如何把不同模块的逻辑整合在一起也是挑战 |
| 成果汇报 | 汇报阶段，主要有两项任务：一是制作汇报版的PPT，要求是完整地保留方案设计的逻辑链，同时精简部分内容，以满足在较短的时间内（比如30分钟-1小时）完成项目成果汇报的要求；同时，PPT要精美、排版清晰；二是根据客户的意见修改方案（包括Word文档和PPT文稿） | 大量的文字修改工作、对客户修改点的厘清和分析                 |

---

### 2.核心需求

#### 2.1 需求概述

搭建一个**企业级 AIGC（AI 生成内容）平台**，实现以下核心目标：

1. **AI Agent 开发与运行**：提供各类 Agent 的开发、部署、运行环境
2. **用户管理与权限控制**：基于 RBAC 的多租户用户管理体系
3. **知识库与智能召回**：基于 RAG 的企业知识管理与智能检索
4. **AI PPT 在线生成**：类似网页版 Kimi 的 AI PPT 功能

#### 2.2 功能模块详述

**模块一：AI Agent 工作台**

| 功能项     | 描述                             | 咨询场景应用       |
| ---------- | -------------------------------- | ------------------ |
| Agent 创建 | 可视化/低代码创建 Agent          | 快速搭建业务 Agent |
| Agent 编排 | 多 Agent 协作、工作流编排        | 复杂任务自动化     |
| 工具调用   | 支持联网搜索、文档处理、数据分析 | 自动收集客户信息   |
| 记忆系统   | 短期/长期记忆，跨会话记忆        | 项目上下文保持     |
| MCP 协议   | 支持 Model Context Protocol      | 标准化工具接入     |

**预设 Agent 清单**：

| Agent 名称     | 功能                           | 应用阶段 |
| -------------- | ------------------------------ | -------- |
| 客户研究 Agent | 自动搜集客户企业信息、行业分析 | 前端销售 |
| 访谈分析 Agent | 批量处理访谈记录，提取关键信息 | 调研诊断 |
| 资料研读 Agent | 自动解析客户资料，生成摘要     | 调研诊断 |
| 报告生成 Agent | 根据大纲自动生成报告初稿       | 方案设计 |
| PPT 生成 Agent | 自动生成汇报 PPT               | 成果汇报 |

**模块二：知识库与 RAG 引擎**

| 功能项   | 描述                           |
| -------- | ------------------------------ |
| 文档上传 | 支持 PDF/Word/PPT/Excel 多格式 |
| 智能分块 | 语义分块，保留上下文           |
| 向量检索 | 基于语义相似度的智能检索       |
| 知识图谱 | 实体关系抽取，多跳推理         |
| 引用追溯 | 回答来源可追溯                 |

**知识库内容**：

- 案例库：历史项目案例（脱敏处理）
- 模板库：PPT 模板、Word 模板
- 方法论库：咨询方法论、分析框架
- 行业资料库：行业报告、政策文件

**模块三：AI PPT 生成器**

| 功能项     | 描述                          |
| ---------- | ----------------------------- |
| 主题生成   | 输入主题，自动生成完整 PPT    |
| 文档转 PPT | 上传 Word/PDF，一键转换为 PPT |
| 模板定制   | 支持企业定制模板              |
| 智能排版   | AI 自动调整布局、配色         |
| 在线编辑   | 支持在线编辑修改              |
| 多格式导出 | PPTX/PDF/图片                 |



## 二、架构方案

### 1.核心设计原则

- **半解耦集成**：以Clawith模块作为主入口，AIPPT和LightRAG保持独立部署和前端，通过NGINX转发各服务
- **打通认证层**：以Clawith模块的登录认证功能为基础，打通AIPPT和LightRAG的认证服务，实现单点登录

---

### 2.技术栈现状

| 组件 | 语言 | 前端框架 | 后端框架 | 部署方式 | 数据库 | 端口 | 许可证 |
| ---- | ---- | -------- | -------- | -------- | ------ | ---- | ------ |
| Clawith | Python + TypeScript | React 19 + Vite + Zustand | FastAPI + SQLAlchemy (async) | Docker / Bare Metal | SQLite / PostgreSQL + Redis | 前端:3008 后端:8008 | Apache 2.0 |
| LightRAG | Python | Vite + React（lightrag_webui） | FastAPI + uv | Docker / Bare Metal | NetworkX/Neo4j/PostgreSQL + NanoVectorDB/Milvus/Qdrant/Faiss 等 | 9621 | MIT |
| AIPPT | TypeScript | Vue 3 + Vite + Pinia | 无独立后端（纯前端 + 外部AI API） | Docker / Bare Metal | 文件系统 / LocalStorage | 5173 | MIT |

**结论**：三个组件技术栈存在差异——Clawith 和 LightRAG 后端均为 Python (FastAPI)，AIPPT 为纯前端应用（Vue 3 + Vite，无独立后端，直接调用外部 AI API）。前端方面，Clawith 使用 React 19 + Vite，LightRAG 的 WebUI 使用 Vite + React，AIPPT 使用 Vue 3 + Vite + Pinia。三者均支持 Docker 部署，可通过 NGINX 统一入口实现反向代理。认证方面，Clawith 和 LightRAG 均具备内置 JWT 认证体系，AIPPT 也内置了 JWT 鉴权模块。数据存储方面三者各自独立。因此采用"半解耦集成"策略：保留各组件独立部署，通过 NGINX 路由和 SSO 打通形成统一产品体验。

---

### 3.目标架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          用户浏览器                                      │
│                     http://localhost:3008                                │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        NGINX (端口 3008)                                  │
│                     反向代理 / 路由分发                                    │
│  ┌──────────────┬──────────────────┬──────────────────────────────┐      │
│  │ /            │ /kb              │ /ppt                         │      │
│  │ → Clawith    │ → LightRAG       │ → AIPPT                      │      │
│  │ :3008/:8008  │ :9621            │ :5173                        │      │
│  └──────────────┴──────────────────┴──────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
         │                  │                       │
         ▼                  ▼                       ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│   Clawith    │  │    LightRAG      │  │       AIPPT          │
│ (主平台)      │  │  (知识库服务)     │  │   (AI PPT 服务)       │
├──────────────┤  ├──────────────────┤  ├──────────────────────┤
│ 前端: React  │  │ 前端: Vite+React │  │ 前端: Vue 3 + Vite   │
│ 后端: FastAPI│  │ 后端: FastAPI    │  │ 后端: 无（纯前端）    │
│ 端口: 8008   │  │ 端口: 9621       │  │ 端口: 5173           │
│              │  │                  │  │                      │
│ · Agent 管理 │  │ · 图谱增强RAG    │  │ · PPT 生成           │
│ · 用户认证   │  │ · 实体关系抽取   │  │ · 画布编辑器         │
│ · MCP 工具   │  │ · 多模式检索     │  │ · AI 对话面板        │
│ · 工作流编排 │  │ · 多向量库支持   │  │ · 多格式导出         │
│ · LLM 配置  │  │                  │  │                      │
└──────┬───────┘  └────────┬─────────┘  └──────────┬───────────┘
       │                   │                        │
       │    ┌──────────────┘                        │
       │    │  MCP 协议调用                          │
       │    ▼                                       │
       │  ┌──────────────────┐                      │
       │  │  LightRAG MCP    │                      │
       │  │ Server (工具层)   │                      │
       │  └──────────────────┘                      │
       │                                            │
       ▼                                            ▼
┌──────────────────────────────────────────────────────────────┐
│                      共享基础设施                              │
├──────────────┬───────────────────┬───────────────────────────┤
│   Redis      │  SQLite/PostgreSQL │     LLM Provider          │
│  (缓存/会话) │  (Clawith 数据)    │  (OpenAI 兼容协议)        │
└──────────────┴───────────────────┴───────────────────────────┘
```

#### 认证流程

```
用户浏览器                    Clawith                  LightRAG/AIPPT
    │                          │                           │
    │  1. 登录 (用户名/密码)    │                           │
    │ ───────────────────────► │                           │
    │                          │  验证身份,生成 JWT Token   │
    │  2. 返回 JWT Token       │                           │
    │ ◄─────────────────────── │                           │
    │                          │                           │
    │  3. 点击 Knowledge Base  │                           │
    │     或 AI PPT 链接       │                           │
    │ ──────────────────────────────────────────────────► │
    │     携带 Token (URL参数 │                           │
    │     或 Cookie)          │                           │
    │                          │                           │
    │                          │  4. 目标服务验证 Token     │
    │                          │ ◄──────────────────────── │
    │                          │                           │
    │  5. 自动登录成功,        │                           │
    │     展示目标页面          │                           │
    │ ◄────────────────────────────────────────────────── │
```

#### 关键设计说明

| 设计点 | 方案 | 说明 |
| ------ | ---- | ---- |
| 统一入口 | NGINX 监听 3008 端口 | 用户只需访问一个地址 |
| 路由规则 | `/` → Clawith, `/kb` → LightRAG, `/ppt` → AIPPT | 路径前缀区分服务 |
| SSO 认证 | Clawith 签发 JWT → 目标服务验证 | 统一身份，一次登录 |
| MCP 集成 | LightRAG 封装为 MCP Server → Clawith Agent 调用 | Agent 可检索知识库 |
| LLM 配置 | AIPPT 通过 CUSTOM 端点指向 Clawith LLM 代理接口 | 统一管理 API Key |
| 数据隔离 | 各组件独立数据库，API 层面交互 | 减少耦合，便于独立升级 |

---

### 4.项目地址

Clawith：https://github.com/dataelement/Clawith

LightRAG：https://github.com/HKUDS/LightRAG

AIPPT：https://github.com/aippt/aippt



## 三、模块划分与开发任务

### 1.模块一：统一认证服务

**目标**：使用 Clawith 内置的用户系统，AIPPT 和 LightRAG 复用。

**需求：**在Clawith模块（也就是未来的Labo-Flow主页）登录之后，通过主页中的跳转链接可以直接完成跳转-认证-登录，直接达到 AIPPT 和 LightRAG 的主页。

**具体路径：**待细化

---

### 2.模块二：Clawith UI改造

**目标**：在Clawith模块主页既有的sidebar内部、Dashboard和Plaza之下，插入两个跳转链接按钮，一个指向LightRAG（即知识库、Knowledge Base）前端页面，另一个指向AIPPT（即AI PPT）的前端页面。

**示意：**

```
 --------------------------------------------------------------------------------------------------
|    Icon             | (banner)                                                                   |
|    Company          |----------------------------------------------------------------------------|
|    +new company     |                                                                            |
|---------------------|                                                                            |
|    Dashboard        |                                                                            |
|    Plaza            |                                                                            |
|    Knowledge Base   |                                                                            |
|    AI PPT           |                                                                            |
|                     |                                                                            |
……
```

---

### 3.模块三：LightRAG知识库服务

**目标**：独立部署LightRAG，封装为MCP工具供Labo-Flow内的Agent调用；同时提供知识库管理界面。

#### 3.1 打通LightRAG的登录认证功能

**目标**：在Clawith模块（也就是未来的Labo-Flow主页）登录之后，通过主页中的跳转链接可以直接完成跳转-认证-登录，直接达到LightRAG WebUI的主页。

**实现方式**：LightRAG已内置JWT鉴权（`lightrag/api/auth.py`），需修改其 `.env` 配置，使其校验Clawith签发的JWT Token（共享SECRET，或通过Clawith `/api/verify-token` 接口进行远程校验）。

#### 3.2 MCP工具定义（要符合MCP协议规范）

**目标：**基于LightRAG的REST API开发MCP Server Wrapper，并添加至Clawith模块，让Agents调取使用。

**LightRAG MCP工具清单（初步）**：

| 工具名 | 功能 | 对应 LightRAG API |
| ------ | ---- | ----------------- |
| `knowledge_search` | 语义检索知识库（支持local/global/hybrid/naive/mix五种模式） | `/query` endpoint |
| `document_upload` | 上传文档到知识库 | `/documents` endpoint |
| `document_list` | 列出知识库文档 | `/documents` list |
| `workspace_create` | 创建知识库命名空间 | LightRAG namespace 管理 |
| `workspace_list` | 列出所有命名空间 | LightRAG namespace 管理 |

---

### 4. 模块四：AIPPT集成

#### 4.1 打通AIPPT的登录认证功能

**目标：**在Clawith模块（也就是未来的Labo-Flow主页）登录之后，通过主页中的跳转链接可以直接完成跳转-认证-登录，直接达到AIPPT主页。

**实现方式**：AIPPT已内置JWT鉴权（`src/api/auth.ts`），需配置使其接受Clawith签发的Token（共享JWT SECRET，或通过Clawith接口验证）。

#### 4.2 修改AIPPT的LLM配置集成

**目标：**使AIPPT统一使用Clawith中配置的LLM Provider，无需用户在AIPPT中单独维护API Key。

**现状说明：**AIPPT已内置多AI提供商路由（`src/utils/ai/`），通过`modelRouter.ts`根据任务类型（文档解析、长文生成、快速编辑等）自动选择DeepSeek、MiniMax、OpenAI等不同模型。同时支持OpenAI Compatible自定义端点（CUSTOM provider）。

**推荐方案：**将AIPPT的所有AI请求统一指向Clawith LLM代理接口，通过修改`src/utils/ai/modelRouter.ts`将所有任务类型映射到CUSTOM provider，并在启动配置中写入Clawith的代理地址和API Key：

```
# AIPPT 环境变量配置（.env）
VITE_CUSTOM_LLM_URL=[Clawith LLM代理地址]
VITE_CUSTOM_API_KEY=[Clawith API Key]
VITE_CUSTOM_MODEL=[Model Name]
```

**备选方案：**在AIPPT前端设置页面中提供LLM Provider配置入口，允许用户手动填写URL、API Key和Model Name，配置信息通过`src/utils/ai/config.ts`持久化至LocalStorage。

**图片生成配置：**AIPPT支持多种图片提供商（Pexels、Unsplash、Pixabay、Giphy等），通过`.env`中的对应API Key配置，可沿用原有方式独立配置。

---

### 5. 模块五：部署与更新

#### 5.1 开发模式

**需求：**参考Clawith的官方脚本、LightRAG的文档（`docs/`）、AIPPT的README.md，设计一个脚本用于启动Clawith、LightRAG、AIPPT和NGINX等模块，以便调试和修改（即要具备热重启能力）

#### 5.2 Docker Compose架构

**需求：**生成一键式脚本，将项目打包成为可以自托管的Docker镜像

#### 5.3 Nginx路由配置

**需求：**前端统一采用3008端口进入，并将`localhost:3008/kb`指向LightRAG的WebUI主页、`localhost:3008/ppt`指向AIPPT的前端主页

#### 5.4 更新与备份

**需求：**1.鉴于上游的Clawith还在快速迭代当中，基于Clawith开发的Labo-Flow应当能够尽可能地兼容上游源码更新，以便增加功能、改进性能或修补bug。2.检查是否具有备份当前Clawith配置的功能，如没有需要有一个一键导出配置、一键还原配置的功能。





## 四、开发计划

### 总体策略

采用**增量迭代**开发模式，每个阶段产出一个可运行的最小可用版本（MVP），逐步叠加功能。各阶段之间存在依赖关系，需按序推进。

---

### 阶段一：环境搭建与基础集成（第1-2周）

**目标**：三个组件在本地独立运行，NGINX 反向代理可用。

| 任务 | 优先级 | 负责模块 | 交付物 |
| ---- | ------ | -------- | ------ |
| 搭建 Clawith 开发环境 | P0 | Clawith | Clawith 本地可运行 |
| 搭建 LightRAG 开发环境 | P0 | LightRAG | LightRAG 本地可运行 (端口 9621) |
| 搭建 AIPPT 开发环境 | P0 | AIPPT | AIPPT 本地可运行 (端口 5173) |
| 配置 NGINX 反向代理 | P0 | 基础设施 | `localhost:3008` 可分发到三个服务 |
| 编写开发模式启动脚本 (dev.sh) | P1 | 基础设施 | 一键启动/热重启所有服务 |

**验收标准**：浏览器访问 `localhost:3008` 可看到 Clawith，`localhost:3008/kb` 可看到 LightRAG WebUI，`localhost:3008/ppt` 可看到 AIPPT。

---

### 阶段二：统一认证服务（第3-4周）

**目标**：实现 SSO 单点登录，从 Clawith 登录后可无缝访问其他服务。

| 任务 | 优先级 | 负责模块 | 交付物 |
| ---- | ------ | -------- | ------ |
| 分析 Clawith JWT 认证机制 | P0 | 认证 | 认证流程文档 |
| 配置 LightRAG 认证 — 共享 Clawith JWT Secret | P0 | LightRAG | 自动登录可用 |
| 配置 AIPPT 认证 — 接受 Clawith JWT Token | P0 | AIPPT | 自动登录可用 |
| 在 Clawith sidebar 添加 Knowledge Base 和 AI PPT 跳转链接 | P0 | Clawith UI | 跳转链接可见且可用 |
| 跳转时自动携带 Token 并完成目标服务认证 | P0 | 认证 | 无感跳转登录 |

**验收标准**：在 Clawith 登录后，点击 sidebar 中的 Knowledge Base / AI PPT 链接，可自动跳转并登录到对应服务，无需再次输入账号密码。

---

### 阶段三：LightRAG MCP 工具封装（第5-6周）

**目标**：LightRAG 的知识库能力可通过 MCP 协议被 Clawith 的 Agent 调用。

| 任务 | 优先级 | 负责模块 | 交付物 |
| ---- | ------ | -------- | ------ |
| 研究 LightRAG REST API 接口 | P0 | MCP | API 接口清单（基于FastAPI自动生成文档） |
| 开发 LightRAG MCP Server | P0 | MCP | 符合 MCP 协议规范的工具服务 |
| 在 Clawith 中注册 MCP Server | P0 | Clawith | Agent 可发现并调用知识库工具 |
| 测试 Agent 调用知识库的完整流程 | P1 | 集成测试 | 端到端调用验证通过 |

**MCP 工具清单（初步）**：

| 工具名 | 功能 | 对应 LightRAG API |
| ------ | ---- | ----------------- |
| `knowledge_search` | 语义检索（支持local/global/hybrid/naive/mix五种模式） | `/query` endpoint |
| `document_upload` | 上传文档到知识库 | `/documents` endpoint |
| `document_list` | 列出知识库文档 | `/documents` list |
| `workspace_create` | 创建知识库命名空间 | LightRAG namespace 管理 |
| `workspace_list` | 列出所有命名空间 | LightRAG namespace 管理 |

**验收标准**：在 Clawith 中创建一个 Agent，配置 LightRAG MCP 工具后，该 Agent 可通过对话方式检索知识库内容。

---

### 阶段四：AIPPT LLM 配置集成（第7周）

**目标**：AIPPT 可使用 Clawith 中配置的 LLM Provider 信息，无需用户在多处重复配置。

| 任务 | 优先级 | 负责模块 | 交付物 |
| ---- | ------ | -------- | ------ |
| 分析 AIPPT `src/utils/ai/modelRouter.ts` 的路由逻辑 | P0 | 架构 | 路由改造方案文档 |
| 实现 AIPPT 统一走 Clawith LLM 代理（CUSTOM provider） | P0 | AIPPT / Clawith | AIPPT 可通过 Clawith 代理接入任意 LLM |
| 配置传递与持久化 | P1 | 集成 | 配置保存后立即生效 |

**推荐方案**：将 AIPPT `modelRouter.ts` 中所有任务类型统一映射到 CUSTOM provider，通过 `VITE_CUSTOM_LLM_URL` / `VITE_CUSTOM_API_KEY` 指向 Clawith 的 LLM 代理接口，理由：
1. 减少用户在多处重复配置 API Key 的工作量
2. 集中管理 LLM Provider 信息，便于更换和审计
3. AIPPT 已有完整的 CUSTOM provider 支持（`src/utils/ai/providers.ts`），改造工作量小

**验收标准**：在 Clawith 中配置好 LLM Provider（URL、API Key、Model Name）后，AIPPT 可直接使用该配置生成 PPT。

---

### 阶段五：预设 Agent 开发（第8-9周）

**目标**：基于已打通的基础设施，开发面向咨询场景的预设 Agent。

| Agent | 依赖模块 | 开发内容 | 优先级 |
| ----- | -------- | -------- | ------ |
| 客户研究 Agent | 联网搜索 + Clawith | 自动搜集企业公开信息、行业报告 | P0 |
| 访谈分析 Agent | LightRAG MCP | 批量上传访谈记录，提取关键观点和共性问题 | P0 |
| 资料研读 Agent | LightRAG MCP | 上传客户资料，生成摘要和关键发现 | P0 |
| 报告生成 Agent | LightRAG MCP + LLM | 根据大纲和知识库内容生成报告初稿 | P1 |
| PPT 生成 Agent | AIPPT API | 根据内容大纲调用 AIPPT 生成汇报 PPT | P1 |

**验收标准**：每个 Agent 可在 Clawith 工作台中独立运行，完成其指定的咨询场景任务。

---

### 阶段六：部署打包与文档（第10-11周）

**目标**：完成 Docker Compose 一键部署，编写运维文档。

| 任务 | 优先级 | 负责模块 | 交付物 |
| ---- | ------ | -------- | ------ |
| 编写 Docker Compose 文件 | P0 | 基础设施 | `docker-compose.yml` 一键启动全部服务 |
| 编写各组件 Dockerfile（如需定制） | P0 | 基础设施 | 定制镜像构建文件 |
| 实现一键配置导出/还原功能 | P1 | Clawith | 配置备份脚本 |
| 编写上游同步脚本（git merge 策略） | P1 | 基础设施 | `update.sh` 更新脚本 |
| 编写部署文档和用户手册 | P1 | 文档 | README、部署指南、使用手册 |

**验收标准**：在一台全新服务器上，通过 `docker-compose up -d` 可在 10 分钟内完成全部服务部署。

---

### 阶段七：测试与优化（第12周）

**目标**：全面测试、修复 Bug、性能优化。

| 任务 | 优先级 | 说明 |
| ---- | ------ | ---- |
| 功能测试 | P0 | 覆盖所有核心流程：登录→跳转→Agent 调用→PPT 生成 |
| SSO 稳定性测试 | P0 | Token 过期、并发登录、跨服务跳转等场景 |
| MCP 调用性能测试 | P1 | 大文档上传、高并发检索的响应时间 |
| 安全审计 | P1 | API Key 存储安全、跨域配置、XSS/CSRF 防护 |
| 用户体验优化 | P2 | 页面加载速度、跳转流畅度、错误提示 |

**验收标准**：核心功能无 P0/P1 级 Bug，系统可在 10 人并发场景下稳定运行。

---

### 里程碑总览

| 里程碑 | 时间 | 标志 |
| ------ | ---- | ---- |
| M1: 基础集成 | 第2周末 | 三服务可通过 NGINX 统一访问 |
| M2: SSO 贯通 | 第4周末 | 一次登录，全平台通行 |
| M3: MCP 打通 | 第6周末 | Agent 可调用知识库 |
| M4: LLM 集成 | 第7周末 | AIPPT 可用统一 LLM 配置 |
| M5: Agent 就绪 | 第9周末 | 5个预设 Agent 可用 |
| M6: 部署就绪 | 第11周末 | Docker 一键部署 |
| M7: 发布就绪 | 第12周末 | 全功能测试通过 |



## 五、风险与应对

### 1. 技术风险

| 风险 | 影响程度 | 概率 | 应对措施 |
| ---- | -------- | ---- | -------- |
| **SSO 跨服务认证兼容性问题**：LightRAG（Python/FastAPI）和 AIPPT（Vue 3 纯前端）的认证机制与 Clawith 不同，JWT 互通需要适配 | 高 | 中 | 1. LightRAG 已内置 JWT 鉴权，优先采用共享 SECRET 方案，评估改造工作量；2. AIPPT 已有 JWT 模块，重点在 Token 传递和校验逻辑；3. 备选方案：采用 OAuth2 Proxy 或 Authentik 等第三方 SSO 网关统一代理认证 |
| **NGINX 路由与前端 SPA 冲突**：LightRAG WebUI 和 AIPPT 均为 SPA 应用，使用 `/kb` 和 `/ppt` 子路径可能导致前端路由和静态资源加载异常 | 高 | 高 | 1. 使用独立子域名（如 kb.example.com / ppt.example.com）替代路径前缀；2. 若必须使用路径前缀，需修改各前端应用的 `base path` 配置（Vite 的 `base`）；3. 在 NGINX 中配置 `try_files` 正确处理 SPA 回退 |
| **LightRAG MCP 封装复杂度**：LightRAG 无原生 MCP Server，需手工基于其 REST API 进行封装 | 中 | 中 | 1. LightRAG API 基于 FastAPI，自动生成 OpenAPI 文档，接口清晰；2. 先实现核心工具（检索、上传），非核心功能后续迭代；3. 参考社区 lightrag-mcp-server 开源实现 |
| **AIPPT 后端依赖澄清**：AIPPT 为纯前端应用，AI 请求直接调用第三方 API，生产环境下 API Key 有暴露风险 | 高 | 高 | 1. 通过 NGINX 代理层拦截 AIPPT 对外的 AI 请求，统一转发至 Clawith LLM 代理接口；2. API Key 仅存于服务端，不写入前端环境变量；3. 通过 NGINX `auth_request` 验证 JWT 后再允许 AI 请求 |
| **AIPPT AI 路由与 Clawith 代理对接**：AIPPT 内置多模型路由（DeepSeek、MiniMax 等），与 Clawith 统一配置存在竞争 | 中 | 中 | 1. 在 AIPPT 的 `modelRouter.ts` 中将所有任务类型映射到 CUSTOM provider，统一走 Clawith LLM proxy；2. 通过 `VITE_CUSTOM_LLM_URL` 等环境变量注入代理地址，无需修改业务逻辑 |
| **跨服务 WebSocket 代理**：LightRAG 的流式查询依赖 Server-Sent Events / WebSocket，NGINX 需要正确配置代理，否则会导致流式响应中断 | 中 | 中 | 1. 在 NGINX 配置中显式添加 WebSocket 升级头：`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "Upgrade"`；2. 设置足够的 `proxy_read_timeout` 防止长连接被断开 |

---

### 2. 工程风险

| 风险 | 影响程度 | 概率 | 应对措施 |
| ---- | -------- | ---- | -------- |
| **上游组件频繁更新导致兼容性破坏**：Clawith、LightRAG、AIPPT 均处于快速迭代期，上游的 API 变更、数据库 Schema 变更可能导致 Labo-Flow 的定制代码失效 | 高 | 高 | 1. 锁定上游版本（使用 Git Tag / 特定 Commit），不盲目追新；2. 定期（如每月）评估上游更新，选择性合并；3. 将定制代码集中在独立模块/补丁文件中，减少与上游代码的冲突面；4. 建立自动化回归测试，升级后快速验证核心功能 |
| **改造代码与上游代码的合并冲突**：对 Clawith sidebar、LightRAG 认证等部分的改造，在上游更新时可能产生 Git 合并冲突 | 高 | 中 | 1. 采用 Fork + 独立分支策略，不直接修改上游源码中的核心文件；2. 将定制逻辑放在独立的插件/扩展文件中（如 Clawith 的插件机制）；3. 使用 Git rebase 而非 merge 保持提交历史清洁；4. 为每次改造维护清晰的变更清单 |
| **多组件部署复杂度高**：三个独立服务 + NGINX + Redis + 数据库，运维和排错成本高 | 中 | 中 | 1. Docker Compose 统一编排，一键管理全部服务；2. 统一日志输出到标准输出，便于集中收集；3. 编写详细的运维手册和常见问题排查指南；4. 提供 `healthcheck` 端点用于监控各服务状态 |
| **数据一致性与备份**：三个组件各自维护独立数据库，数据备份和恢复策略需要分别处理 | 中 | 中 | 1. 编写统一的备份脚本，同时导出所有组件的数据/配置；2. 定期执行自动化备份（如每日增量 + 每周全量）；3. 备份文件统一存储到指定目录，支持一键还原 |
| **开发团队对多个技术栈的熟悉度**：团队需要同时维护 Python (FastAPI) 和 Vue 3 (TypeScript) 两套技术栈 | 中 | 低 | 1. LightRAG 后端为 Python/FastAPI，与 Clawith 同栈，改造工作量小；2. AIPPT 的改造主要集中在 `src/utils/ai/` 配置层面，减少深入业务逻辑的需要；3. 将 AIPPT 视为"黑箱"前端，仅通过配置与之集成；4. 编写清晰的接口文档降低理解门槛 |
| **性能瓶颈**：多服务并行运行对服务器资源要求较高，尤其是 LLM 推理和向量检索 | 中 | 中 | 1. 推荐最低服务器配置：8核 CPU / 16GB RAM / 100GB SSD；2. 使用 Redis 缓存热点数据减少重复计算；3. 对大文档处理采用异步队列，避免阻塞主线程；4. 监控各服务资源占用，必要时独立扩容 |

