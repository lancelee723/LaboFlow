# Pro Slides 简化方案：复用 Clawith Agent Runtime + SVG 实时渲染

日期：2026-05-27

## 背景

Pro Slides 当前架构复杂：Next.js 前端 + Express daemon（代理 LLM 调用）+ Claude Code CLI agent。维护成本高，且 daemon 层与 Clawith 功能大量重叠。本方案砍掉 daemon，复用 Clawith Agent Runtime 做 LLM 调用，前端保留并改造，实现两个核心功能：

1. **实时渲染 PPT（SVG）**：LLM 输出完整 SVG，前端通用画布渲染
2. **保留对话窗体的气泡选择组件**：direction-cards 组件不变，由 Clawith Agent 的 AskUserQuestion 工具触发

## 架构

```
┌─────────────────────────────────────────────┐
│           Pro Slides Frontend               │
│  (Next.js 16 + React 18, 现有代码改造)       │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ ChatPane │  │ SVG Deck │  │ Question  │ │
│  │ (改造)    │  │ Renderer │  │ Form(保留) │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│  ┌────┴──────────────┴──────────────┴─────┐ │
│  │       ClawithWSProvider (新增)          │ │
│  │  - WS 连接管理                          │ │
│  │  - 消息格式适配 (Clawith → 前端事件)     │ │
│  │  - SSO token 传递                       │ │
│  └──────────────┬─────────────────────────┘ │
└─────────────────┼───────────────────────────┘
                  │ WebSocket: /ws/chat/{ppt_agent_id}
                  │ (走现有 Nginx /ws location，不改 Nginx)
                  ▼
┌─────────────────────────────────────────────┐
│        Clawith Backend (零代码改动)          │
│                                             │
│  PPT Agent (access_mode=private,            │
│             is_system=True)                 │
│  - 管理后台手动创建，创建者可见             │
│  - 内置 soul.md + skills                    │
│  - 复用 Clawith 的 LLM 配置和会话管理       │
│                                             │
│  复用: LLM 配置、WebSocket、会话管理         │
└─────────────────────────────────────────────┘
```

### 关键决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 删除 daemon | 是 | 去除重复的 agent runtime 层 |
| 隐藏 Agent 方案 | `access_mode=private` + `is_system=True` | 零 Clawith 代码改动，admin 仍可见但可接受 |
| SVG 渲染方式 | LLM 输出完整 SVG，前端通用画布渲染 | 不预定义布局组件，布局数量不受限 |
| WebSocket 路径 | 前端直连 `/ws/chat/{agent_id}` | 走现有 Nginx WS location，无需改 Nginx 配置 |
| Nginx 配置 | 不改 | 前端用 `/ws` 路径而非 `/ppt/ws/` |

## SVG 实时渲染

### 设计思路

LLM 基于已有的 ppt-master skill + design-template，直接输出每张幻灯片的完整 SVG 代码。前端不做布局判断，只提供 SVG 画布 + 通用渲染能力。

### 前端职责

- SVG 画布容器（1280×720 viewBox，CSS 缩放适配）
- 幻灯片导航（上一张/下一张）
- palette 实时换肤
- 缩略图生成

### LLM 输出格式

```json
{
  "tool": "generate_slides",
  "result": {
    "slides": [
      {
        "id": "slide-1",
        "svg": "<svg viewBox=\"0 0 1280 720\" xmlns=\"...\">...</svg>",
        "note": "开场介绍"
      }
    ]
  }
}
```

### 为什么不预定义布局组件

- ppt-master 背后的 design-templates 已有 30+ 种布局（html-ppt 31 种、guizang-ppt 10 种、simple-deck 8 种）
- 预定义布局组件会导致：布局数量受限、新增模板需改前端、维护成本高
- 让 LLM 直接输出 SVG：任何已有或未来的模板布局都能直接渲染

## ClawithWSProvider

### 职责

1. WebSocket 连接管理：连接 `ws://{host}:{port}/ws/chat/{ppt_agent_id}`，携带 SSO JWT token
2. 消息格式适配：Clawith WS 消息 → 前端 ChatPane/AssistantMessage 事件
3. 工具调用处理：识别 `tool_call` 事件，路由到不同处理器
4. 重连机制：断线自动重连，恢复会话

### 消息格式映射

| Clawith WS 事件 | 前端事件 | 处理 |
|---|---|---|
| `{ type: "chunk", content }` | `text_delta` | 追加到聊天文本 |
| `{ type: "thinking", content }` | `thinking_delta` | 显示思考过程 |
| `{ type: "tool_call", tool: "generate_slides", ... }` | `live_artifact` | 解析 SVG slides，渲染到画布 |
| `{ type: "tool_call", tool: "ask_direction", ... }` | `tool_use` (AskUserQuestion) | 渲染 direction-cards |
| `{ type: "tool_call", tool: "export_pptx", ... }` | 自定义事件 | 触发文件下载 |
| `{ type: "done", content }` | `end` | 轮次结束 |
| `{ type: "error", content }` | `error` | 显示错误 |

### SSO 认证流程

1. Clawith 前端 → `GET /api/enterprise/pro-slides/sso-token` → 获取 JWT
2. 打开 Pro Slides URL，携带 token
3. Pro Slides 前端存储 token，WebSocket 连接时携带

### PPT Agent ID 传递

PPT Agent 在 Clawith 管理后台创建后获得一个 UUID。该 ID 通过环境变量 `PPT_AGENT_ID` 注入 Pro Slides 前端（docker-compose.yml 中配置），前端代码通过 `import.meta.env.PPT_AGENT_ID` 或 `process.env.NEXT_PUBLIC_PPT_AGENT_ID` 读取。

### Nginx 反代注意事项

- 前端 WS 连接使用 `/ws/chat/{agent_id}`，**不是** `/ppt/ws/...`
- 现有 Nginx `/ws` location 已有 WebSocket 代理支持（Upgrade 头 + 86400 超时）
- `/ppt/api/` location **不支持 WebSocket**（缺少 Upgrade 头），不能用 `/ppt/api/ws/...`
- 静态文件仍走 `/ppt/` → `pro-slides:7456`

## PPT Agent 配置

### 创建方式

在 Clawith 管理后台手动创建：

- **name**: "PPT Slides"
- **access_mode**: "private"
- **is_system**: True
- **primary_model**: 复用 Clawith 模型池配置

### 内置 Skills

1. **ppt-master**（复用现有）— 编排 skill，根据 topic/style/slides_count 生成完整 PPT
2. **ppt-direction**（新增）— 输出 `<question-form>` XML，触发 direction-cards 选择
3. **ppt-svg-render**（新增）— 指导 LLM 输出 SVG 幻灯片而非 HTML

### 生成流程

```
用户输入: "帮我做一个10页的季度汇报PPT"
    │
    ▼
PPT Agent 收到消息
    │
    ▼
Step 1: Agent 调用 ask_direction 工具
    → 输出 direction-cards (风格/配色选项)
    → 前端渲染 direction-cards, 用户选择
    │
    ▼
Step 2: Agent 收到用户选择, 调用 ppt-master skill
    → 基于 design-template + 用户选择的方向
    → 生成每张幻灯片的 SVG
    │
    ▼
Step 3: Agent 调用 generate_slides 工具
    → 输出 JSON: { slides: [{ id, svg, note }] }
    → Clawith WS 推送 tool_call 事件
    → 前端解析 SVG, 渲染到画布
    │
    ▼
Step 4: 用户可继续对话调整
    → Agent 增量修改特定幻灯片
    → 输出更新后的 SVG
```

## 前端改动清单

| 文件/目录 | 操作 | 说明 |
|-----------|------|------|
| `apps/daemon/` | **删除** | 去除整个 daemon 层 |
| `apps/web/src/providers/daemon.ts` | **替换** | 替换为 `ClawithWSProvider` |
| `apps/web/src/providers/sse.ts` | **删除** | 不再用 SSE |
| `apps/web/src/providers/websocket.ts` | **改造** | 连接 `/ws/chat/{ppt_agent_id}` |
| `apps/web/src/providers/sso-auth.ts` | **保留** | 可能微调 token 传递方式 |
| `apps/web/src/runtime/srcdoc.ts` | **替换** | 替换为 SVG 渲染逻辑 |
| `apps/web/src/components/FileViewer.tsx` | **改造** | 用 SVG 画布替代 iframe |
| `apps/web/src/components/SlideNavigator.tsx` | **保留** | — |
| `apps/web/src/components/ChatPane.tsx` | **改造** | 适配 Clawith 消息格式 |
| `apps/web/src/components/QuestionForm.tsx` | **保留** | — |
| `apps/web/src/components/AssistantMessage.tsx` | **改造** | 适配 tool_call 事件渲染 |
| `nginx/docker.conf` | **不改** | 前端用 `/ws` 直连，无需改 Nginx |
| `docker-compose.yml` | **改** | 删除 daemon 相关配置，精简 pro-slides service |

## 不在范围内

- Clawith 后端代码改动（使用现有 access_mode + is_system 实现隐藏）
- Nginx 配置改动（复用现有 `/ws` location）
- PPTX 导出功能（后续迭代）
- 多用户协作编辑
- 幻灯片动画/过渡效果
