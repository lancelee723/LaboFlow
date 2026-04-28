# RAGFlow MCP 集成 Clawith Agent — 设计稿

**日期：** 2026-04-28
**作者：** lance + Claude（共同 brainstorm）
**前置：** `docs/superpowers/plans/2026-04-28-ragflow-replace-lightrag.md`（RAGFlow 替换 LightRAG 已完成的 commit 链）
**状态：** 待审 → 通过后 invoke writing-plans 出实施计划

---

## Goal

让 Clawith 的 Agent 能在对话中通过 MCP 协议查询 RAGFlow 知识库——典型场景：用户说"去知识库查 XX"，Agent 自动调用 RAGFlow 检索工具，返回带文件名+页码+相似度的引用列表，让 LLM 直接复述给用户。

**不在本期范围内：** 知识库管理操作（创建数据集、上传文档、解析）仍由用户走 Sidebar SSO 跳到 RAGFlow Web UI 自行操作。

---

## Decisions Summary

所有关键产品 / 技术决策来自 brainstorm 会话：

| 维度 | 决定 | 备注 |
|---|---|---|
| 范围 | A — 仅检索 | 管理操作走已有 SSO 跳 RAGFlow Web |
| 集成路径 | 仅 MCP，**不接入** RAGFlow 官方下载的 Skill 脚本套件 | 守住"仅 MCP"原则 |
| 源文件展示 | 仅文本引用（文件名 + 页码 + 相似度 + doc_id） | 不渲染 PDF 页面截图 |
| 鉴权模式 | host 模式 + per-Agent API Key | RAGFlow MCP 启动用 `--mode=host`，复用 Clawith 已有"工具配置 UI"机制（Tavily 同款） |
| 检索参数 | 锁定 / 不暴露给 Agent | 保留 RAGFlow 默认（page_size=30 / similarity_threshold=0.2 / vector_weight=0.3 / top_k=1024）；Agent 看到的 schema 仅 `question` + `dataset_ids` |
| 工具数量 | 1 个 (`ragflow_retrieval`) | 不补 list_datasets——dataset 清单由 RAGFlow MCP server 嵌在 `tools/list` 返回的 description 字段中 |
| 多租户隔离 | 自动隔离 | host 模式按 API Key 鉴权，每个 Clawith 用户拿自己的 RAGFlow Key → 自己看见自己的 dataset 池 |
| Tool seed 位置 | `tool_seeder.py` 的 `BUILTIN_TOOLS` | category=`knowledge`（新增），icon=📚，is_default=False |

---

## Architecture

### 通信链路全景

```
[Clawith Agent (websocket.py)]
  └─▶ _execute_mcp_tool("ragflow_retrieval", {question, dataset_ids?})
       │   1. 从 DB 读 Tool 行 (mcp_server_url, mcp_tool_name, mcp_server_name="RAGFlow")
       │   2. merged_config = {**Tool.config, **AgentTool.config}
       │   3. _decrypt_sensitive_fields → 解出 api_key (per-Agent 配置的 RAGFlow Key)
       │   4. 预检查：缺 api_key 直接返回友好提示
       │   5. MCPClient(url, api_key=<RAGFlow API Key>, timeout=30) → call_tool
       │
       ▼
[mcp_client.py]   Authorization: Bearer <RAGFlow API Key>
       │   POST <RAGFLOW_MCP_URL>  (Streamable HTTP, fallback SSE)
       │
       ▼ (dev: localhost / docker: ragflow 内部网络)
[RAGFlow MCP server :9382]   --mode=host
       │   AuthMiddleware: 从 Authorization 头取 api_key
       │   connector.retrieval(api_key, dataset_ids?, question)
       │     ├─ GET 127.0.0.1:9380/datasets       (列出该 key 可见 dataset)
       │     └─ POST 127.0.0.1:9380/retrieval     (查 chunks，自动注入 metadata cache)
       │
       ▼
[RAGFlow REST :9380]   按 API Key 鉴权返回属于该 RAGFlow 用户的 chunks
       │
       ▼
[ragflow MCP server]   注入 dataset_name / document_metadata → JSON
       │
       ▼
[Clawith _execute_mcp_tool]   _format_ragflow_response(JSON) → markdown
       │
       ▼
[Agent LLM]   接收 markdown → 复述给用户 + 列引用源
```

### 双部署形态对照

| 维度 | Dev 模式（dev.sh） | 生产模式（docker compose） |
|---|---|---|
| RAGFlow API server | venv + `python api/ragflow_server.py` | ragflow-cpu 容器 |
| RAGFlow Task Executor | venv + `python rag/svr/task_executor.py 0` | ragflow-cpu 容器 |
| RAGFlow Web | venv + `npm run dev` (vite) | ragflow-cpu 容器（已 build） |
| **RAGFlow MCP Server** | **venv + `python mcp/server/server.py`** | **ragflow-cpu 容器（`--enable-mcpserver`）** |
| MCP bind | `127.0.0.1:9382`（loopback） | `0.0.0.0:9382`（容器内） |
| Clawith → MCP URL | `http://localhost:9382/mcp` | `http://ragflow-cpu:9382/mcp` |
| 启动文件 | `dev.sh` | `docker-compose.yml`（顶层 include `ragflow/docker/`） |
| RAGFlow base 服务 | `docker-compose-base.yml`（MySQL/ES/Redis/MinIO） | 同上（compose include） |

---

## Section 1 / 架构与通信链路（关键事实）

- RAGFlow MCP Server 跟 ragflow-cpu **是同一个 python 项目的不同入口**（`mcp/server/server.py` vs `api/ragflow_server.py`）。docker 模式下两者同进程或同容器；dev 模式下并列两个 python 进程。
- Clawith mcp_client.py 已经支持 Streamable HTTP（`/mcp` 端点）+ SSE 双协议自动 fallback。**复用现有客户端，零新代码**。
- Clawith Tool 表已有 `mcp_server_url` / `mcp_server_name` / `mcp_tool_name` 字段（Smithery / Atlassian 等已在用）。**接入新 MCP 服务器只需 seed 一行 Tool**。
- MCP 端口 **不暴露公网、不走 nginx 反代**——它是服务间通信，agent-only。

---

## Section 2 / RAGFlow MCP Server 启用配置

### 2.1 docker-compose.yml（生产 / 镜像部署形态）

修改 `ragflow/docker/docker-compose.yml`，解开 `ragflow-cpu` service 中当前注释掉的 MCP 启动参数：

```yaml
ragflow-cpu:
  command:
    - --enable-mcpserver
    - --mcp-host=0.0.0.0
    - --mcp-port=9382
    - --mcp-base-url=http://127.0.0.1:9380
    - --mcp-script-path=/ragflow/mcp/server/server.py
    - --mcp-mode=host
    # 不设 --mcp-host-api-key — host 模式下从请求 Authorization 头取 token
  ports:
    - ${SVR_WEB_HTTP_PORT}:80
    - ${SVR_MCP_PORT:-9382}:9382
```

**修改 `ragflow/docker/.env`：**

```bash
# Bind MCP port to host (optional — needed only for ad-hoc curl debugging)
SVR_MCP_PORT=9382
```

> 注释 `optional`：docker 内部通信走的是 service name `ragflow-cpu` + 容器内端口 `9382`，不依赖主机端口绑定。

### 2.2 顶层 docker-compose.yml

由于顶层用了 `include: ragflow/docker/docker-compose.yml`，2.1 的 ragflow-cpu command 改动**自动生效**。**只需对 clawith-backend service 显式注入 docker 内部 URL：**

```yaml
clawith-backend:
  environment:
    RAGFLOW_MCP_URL: http://ragflow-cpu:9382/mcp
```

### 2.3 nginx.conf

**不改动**。MCP 是服务间通信，不暴露公网。

---

## Section 3 / Clawith 端 Tool 行 seed

### 3.1 新增 category：`knowledge`

i18n 同步（`Clawith/frontend/src/i18n/en.json` + `zh.json`）：

```json
"agent": {
  "toolCategories": {
    "knowledge": "Knowledge Base"   // zh: "知识库"
  }
}
```

### 3.2 在 `Clawith/backend/app/services/tool_seeder.py` 的 `BUILTIN_TOOLS` 列表新增

```python
import os
...
{
    "name": "ragflow_retrieval",
    "display_name": "RAGFlow Retrieval",
    "description": (
        "Retrieve relevant chunks from the user's RAGFlow knowledge base. "
        "Each user must paste their own RAGFlow API key in this tool's settings; "
        "the key determines which datasets are visible. "
        "When asked to look something up in the knowledge base, call this tool "
        "with the user's question. Optionally narrow the search to specific "
        "datasets by passing dataset_ids (the available dataset list with their "
        "descriptions and IDs is included in the runtime tool description "
        "returned by the MCP server)."
    ),
    "category": "knowledge",
    "icon": "📚",
    "is_default": False,
    "type": "mcp",
    "mcp_server_url": os.getenv("RAGFLOW_MCP_URL", "http://localhost:9382/mcp"),
    "mcp_server_name": "RAGFlow",
    "mcp_tool_name": "ragflow_retrieval",
    "parameters_schema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "The question or query to search for.",
            },
            "dataset_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Optional. Array of dataset IDs to scope the search. "
                    "Leave empty/omit to search across ALL datasets the user "
                    "has access to. The list of available dataset names + IDs "
                    "is provided by the MCP server at runtime."
                ),
            },
        },
        "required": ["question"],
    },
    "config": {},
    "config_schema": {
        "fields": [
            {
                "key": "api_key",
                "label": "RAGFlow API Key",
                "type": "password",
                "default": "",
                "placeholder": "ragflow-xxxxxxxxxxxxxxxxxxxxxxxx (generate at /rag/profile)",
                "help": (
                    "Open the Knowledge Base sidebar item to log in to RAGFlow, "
                    "then go to Profile → API Keys to generate one. The key "
                    "determines which RAGFlow account's datasets the agent can "
                    "search."
                ),
            },
        ]
    },
},
```

### 3.3 Seeder upsert 行为加固

`tool_seeder.py` 现有按 `name` 去重逻辑需确认：对 `type=mcp` 的工具，**每次启动都更新 `mcp_server_url` 字段**（覆盖 DB 旧值），而非"已存在就跳过"。这样切换 dev ↔ docker 部署形态时不必手动改 DB。

如果现有 seeder 是"name 存在就完全跳过"，实施时需做小改；如果已经是"upsert 关键字段"，确认 `mcp_server_url` 在更新字段列表里即可。

---

## Section 4 / 返回结果格式化

### 4.1 实现位置

在 `Clawith/backend/app/services/agent_tools.py:3641` 的 `_execute_mcp_tool` 里，调 `client.call_tool(...)` 拿到结果后判断 `tool.mcp_server_name == "RAGFlow"`，跑 `_format_ragflow_response`。

```python
raw = await client.call_tool(mcp_name, arguments)
if tool.mcp_server_name == "RAGFlow":
    return _format_ragflow_response(raw)
return raw
```

### 4.2 `_format_ragflow_response` 实现

```python
import json

def _format_ragflow_response(raw: str) -> str:
    """Convert RAGFlow MCP JSON → compact markdown citation list."""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw  # fallback: hand the raw string to the LLM

    chunks = data.get("chunks", [])
    if not chunks:
        return "Knowledge base returned no relevant results for this query."

    pagination = data.get("pagination", {})
    total = pagination.get("total_chunks", len(chunks))

    lines = [f"Knowledge base returned {len(chunks)} chunks "
             f"(of {total} matching) — sorted by relevance:\n"]

    for i, c in enumerate(chunks, 1):
        sim = c.get("similarity", 0)
        sim_pct = f"{int(sim * 100)}%"
        doc_name = c.get("document_keyword") or c.get("document_name") or "(unknown doc)"
        ds_name = c.get("dataset_name") or "(unknown dataset)"
        positions = c.get("positions") or []
        page = positions[0][0] if positions and isinstance(positions[0], list) and positions[0] else None
        page_str = f" · p.{page}" if page else ""
        content = (c.get("content") or "").strip().replace("\n", " ")
        if len(content) > 400:
            content = content[:400] + "…"
        doc_id = c.get("document_id", "")
        ds_id = c.get("dataset_id", "")

        lines.append(
            f"[{i}] **{doc_name}**{page_str} · {ds_name} · sim {sim_pct}\n"
            f"> {content}\n"
            f"  (doc_id={doc_id}, dataset_id={ds_id})"
        )

    return "\n\n".join(lines)
```

### 4.3 设计要点

- **chunk 内容截 400 字符**：RAGFlow chunk 本身约 200-800 字符，截 400 对绝大多数 chunk 不丢核心语义；超长 chunk 加 `…` 标识截断。
- **保留 `doc_id` / `dataset_id`**：让 LLM 在多轮对话中如需"再仔细查那份文档"可以传 `document_ids` 精确检索。这些 ID 用户看不见但对 Agent 是定位锚。
- **不在 Clawith 端覆盖 page_size/similarity_threshold/vector_weight/top_k**：完全用 RAGFlow 默认值（30/0.2/0.3/1024）。
- **fallback**：JSON 解析失败时原样返回 raw text，让 LLM 仍能消费（即便降级）。

---

## Section 5 / Dev 模式（dev.sh）启动 MCP Server

### 5.1 dev.sh 改动

**顶部端口变量段（行 90 附近）加：**

```bash
: "${RAGFLOW_MCP_PORT:=9382}"
```

**Pre-flight cleanup 端口列表（行 127）加 `$RAGFLOW_MCP_PORT`。**

**在 task_executor 启动之后、web frontend 启动之前**插入新进程：

```bash
log "Starting RAGFlow MCP server on :$RAGFLOW_MCP_PORT (mode=host) ..."
cd "$RAGFLOW_DIR"
nohup env PYTHONPATH="$RAGFLOW_DIR" \
    HF_ENDPOINT=https://hf-mirror.com \
    "$RAGFLOW_DIR/.venv/bin/python" mcp/server/server.py \
        --host=127.0.0.1 \
        --port="$RAGFLOW_MCP_PORT" \
        --base-url=http://127.0.0.1:9380 \
        --mode=host \
    > "$LOG_DIR/ragflow-mcp.log" 2>&1 &
echo $! > "$PID_DIR/ragflow-mcp.pid"
cd "$ROOT"
```

> `--host=127.0.0.1`（不是 `0.0.0.0`）——dev 模式下 Clawith backend 也跑在主机上，loopback 即可，不必对外暴露。

**Wait_port 段（行 246 附近）加：**

```bash
wait_port "$RAGFLOW_MCP_PORT" "RAGFlow MCP" 30 || true
```

**Summary 段加一行（debug 区域）：**

```bash
echo -e "    RAGFlow MCP       http://localhost:$RAGFLOW_MCP_PORT/mcp  (server-to-server)"
```

**Clawith backend 启动段注入 env：**

```bash
nohup env PYTHONUNBUFFERED=1 \
    JWT_SECRET_KEY="$JWT_SECRET_KEY" \
    DATABASE_URL="$DATABASE_URL" \
    PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
    RAGFLOW_MCP_URL="${RAGFLOW_MCP_URL:-http://localhost:9382/mcp}" \   # 新增
    .venv/bin/uvicorn app.main:app ...
```

### 5.2 stop.sh 改动

`stop.sh` 现有按 PID 文件循环逻辑会自动处理 `ragflow-mcp.pid`。**仅需在端口扫描列表加 `$RAGFLOW_MCP_PORT`** 兜底。

---

## Section 6 / 生产模式（docker compose）启动 MCP Server

参见 Section 2 — docker-compose 改动。本节强调与 dev 模式的差异：

- `--mcp-host=0.0.0.0`（dev 是 `127.0.0.1`），因为容器间通信跨网络命名空间
- 顶层 `docker-compose.yml` 的 `clawith-backend.environment` 注入 `RAGFLOW_MCP_URL=http://ragflow-cpu:9382/mcp`
- `${SVR_MCP_PORT:-9382}:9382` 主机端口暴露**可选**——纯生产部署可省，调试时保留

---

## Section 7 / 双形态环境变量与 URL 处理

### 7.1 顶层 `.env.example` 修订

```bash
# ─── RAGFlow MCP (server-to-server, internal) ────────
# Dev mode: dev.sh launches RAGFlow MCP server at localhost:9382 directly.
# Docker mode: docker-compose overrides this to http://ragflow-cpu:9382/mcp.
# Per-user API keys are configured per-Agent in Clawith UI (like Tavily).
RAGFLOW_MCP_URL=http://localhost:9382/mcp
RAGFLOW_MCP_PORT=9382
```

### 7.2 setup-all.sh sanity check

```bash
# Verify RAGFlow MCP module exists in venv
if [ -f "$ROOT/ragflow/mcp/server/server.py" ]; then
    ok "RAGFlow MCP server script present"
    if "$ROOT/ragflow/.venv/bin/python" -c "import click, starlette" 2>/dev/null; then
        ok "RAGFlow MCP dependencies installed"
    else
        warn "RAGFlow MCP deps may be missing — re-run 'cd ragflow && uv sync --all-extras'"
    fi
else
    warn "ragflow/mcp/server/server.py missing — RAGFlow checkout incomplete"
fi

# Verify docker-compose has MCP enabled (production deploy readiness)
if grep -q "^[[:space:]]*- --enable-mcpserver" "$ROOT/ragflow/docker/docker-compose.yml"; then
    ok "RAGFlow MCP enabled in docker-compose (production deploy ready)"
else
    warn "RAGFlow MCP NOT enabled in docker-compose.yml — fine for dev, required for docker prod deploy"
fi
```

---

## Section 8 / 错误处理、边界、测试

### 8.1 Agent 友好兜底文案

| 场景 | 触发条件 | Agent 看到 |
|---|---|---|
| RAGFlow 未启动 | MCP URL connection refused | `❌ MCP tool execution error: Connection refused (RAGFlow may not be running)` |
| MCP server 跑着但 RAGFlow API 挂了 | MCP 抛 "Cannot process this operation." | `❌ Knowledge base backend unavailable. Please retry later.` |
| API Key 未配置 | `merged_config.get("api_key")` is None | `❌ This agent has no RAGFlow API key configured. Open Agent settings → RAGFlow Retrieval → paste your API Key.` |
| API Key 无效 / 过期 | RAGFlow 返回 401/403 | `❌ RAGFlow rejected the API key. Generate a new one in RAGFlow Profile and update Agent settings.` |
| 该用户无可见 dataset | MCP 抛 "No accessible datasets found." | `Knowledge base has no datasets configured. Visit the Knowledge Base sidebar to create one and upload documents.` |
| 检索零结果 | chunks 为空 | `Knowledge base returned no relevant results for this query.` |
| JSON 解析失败 | server 返回非预期格式 | 原样返回 raw text |
| 超时 | mcp_client httpx timeout | `❌ Knowledge base query timed out after 30s.` |

**实现位置：** 全部在 `_execute_mcp_tool` 的 try/except + `_format_ragflow_response` 分支。**不抛异常上去**——Agent 工具循环要看到字符串，由 LLM 自然回复用户。

### 8.2 API Key 缺失预检查

```python
if tool.mcp_server_name == "RAGFlow":
    if not direct_api_key:
        return ("❌ This agent has no RAGFlow API key configured. "
                "Open Agent settings → RAGFlow Retrieval → paste your API Key. "
                "Generate one at the Knowledge Base sidebar (Profile → API Keys).")
```

放在 `MCPClient(...)` 之前，省掉一次必败的网络请求。

### 8.3 超时配置

`mcp_client.py` 当前 `httpx.AsyncClient` 默认 5 秒。RAGFlow 检索冷启动 + ES 查询可能 10-20 秒。给 RAGFlow 调用单独提到 30 秒：

```python
client = MCPClient(mcp_url, api_key=direct_api_key,
                   timeout=30 if tool.mcp_server_name == "RAGFlow" else None)
```

需在 `MCPClient.__init__` 加可选 `timeout` 参数（默认仍 5s 不影响既有 MCP 工具）。**这是本期对 mcp_client.py 唯一改动**。

### 8.4 边界条件

- **MCP 工具描述长度膨胀**：`tools/list` 返回的工具描述里嵌了所有可见 dataset 的 description+ID。dataset 数 > 50 时可能每次工具列表请求几千 tokens。**MVP 不限制**——观察实际使用，作为 follow-up TODO。
- **RAGFlow 重启瞬时不可用**：dev 模式下 wait_port 30s 应该够；docker 模式由 healthcheck 保证。瞬时不可用走"connection refused"兜底。
- **多 Agent 并发同一 API Key**：RAGFlow + Clawith 都是 stateless 调用，无需特殊处理。
- **API Key 加密存储**：复用 `_decrypt_sensitive_fields`——零新代码。

### 8.5 单元测试（新增 `Clawith/backend/tests/test_ragflow_mcp.py`）

```python
import json, importlib, os
import pytest


def test_format_ragflow_normal():
    from app.services.agent_tools import _format_ragflow_response
    raw = json.dumps({"chunks": [{"content":"...","similarity":0.85,
                                   "document_keyword":"X.pdf","positions":[[12,0,0,0,0]],
                                   "dataset_name":"DS","document_id":"d1","dataset_id":"s1"}],
                      "pagination":{"total_chunks":1}})
    out = _format_ragflow_response(raw)
    assert "X.pdf" in out and "p.12" in out and "85%" in out
    assert "doc_id=d1" in out


def test_format_ragflow_empty():
    from app.services.agent_tools import _format_ragflow_response
    out = _format_ragflow_response(json.dumps({"chunks":[]}))
    assert "no relevant results" in out


def test_format_ragflow_malformed_falls_back_to_raw():
    from app.services.agent_tools import _format_ragflow_response
    out = _format_ragflow_response("not json")
    assert out == "not json"


def test_format_ragflow_truncates_long_content():
    from app.services.agent_tools import _format_ragflow_response
    chunk = {"content": "x" * 1000, "similarity": 0.5,
             "document_keyword":"X","dataset_name":"DS","document_id":"","dataset_id":""}
    out = _format_ragflow_response(json.dumps({"chunks":[chunk]}))
    assert "…" in out and len(out) < 1500


@pytest.mark.asyncio
async def test_ragflow_missing_api_key_returns_helpful_message(monkeypatch):
    # 装一个 type=mcp 的 RAGFlow Tool 行 + AgentTool 配置无 api_key
    # 调 _execute_mcp_tool, 断言返回包含 "no RAGFlow API key configured"
    ...  # 完整实现在 plan 阶段细化


def test_seeder_includes_ragflow_with_env_url(monkeypatch):
    monkeypatch.setenv("RAGFLOW_MCP_URL", "http://test:9382/mcp")
    from app.services import tool_seeder
    importlib.reload(tool_seeder)
    ragflow_tool = next(t for t in tool_seeder.BUILTIN_TOOLS if t["name"] == "ragflow_retrieval")
    assert ragflow_tool["mcp_server_url"] == "http://test:9382/mcp"
    assert ragflow_tool["mcp_tool_name"] == "ragflow_retrieval"
    assert ragflow_tool["mcp_server_name"] == "RAGFlow"
```

### 8.6 集成测试（标记为 integration，需真起 RAGFlow）

```python
@pytest.mark.skipif(not os.getenv("RAGFLOW_TEST_API_KEY"),
                    reason="Set RAGFLOW_TEST_API_KEY to run")
async def test_end_to_end_retrieval_against_real_ragflow():
    result = await _execute_mcp_tool(
        "ragflow_retrieval",
        {"question": "test query"},
        agent_id=fixture_agent_with_ragflow_key,
    )
    assert "Knowledge base" in result
    assert "sim" in result or "no relevant results" in result
```

### 8.7 手动冒烟脚本（验收阶段直接复制粘贴）

```bash
# 1. dev.sh 启动后, 直接 curl MCP server (initialize)
curl -i http://localhost:9382/mcp -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_RAGFLOW_API_KEY>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"test","version":"1.0"}}}'
# 预期: 200 + JSON 含 serverInfo

# 2. 列工具
curl -s http://localhost:9382/mcp -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
# 预期: 含 ragflow_retrieval, description 嵌入 dataset 列表

# 3. 调用检索
curl -s http://localhost:9382/mcp -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"ragflow_retrieval","arguments":{"question":"test"}}}'
# 预期: 200 + JSON 含 chunks 数组
```

### 8.8 端到端验收 checklist

- [ ] dev.sh 启动后 4 个 RAGFlow 进程都健康（api 9380 / task_executor / web 8880 / mcp 9382）
- [ ] Clawith 后端日志中可见 `tool_seeder` upsert `ragflow_retrieval` 行，`mcp_server_url=http://localhost:9382/mcp`
- [ ] 在 RAGFlow Web UI 创建 1 个 dataset、上传 1 个测试 PDF、parse 完成
- [ ] 在 RAGFlow Profile 生成 API Key
- [ ] 在 Clawith 创建 Agent → 工具列表勾选"RAGFlow Retrieval" → 弹窗粘贴 API Key → 保存
- [ ] 与该 Agent 对话 "去知识库查 XX" → Agent 调用 ragflow_retrieval → 返回带文件名/页码/相似度的引用列表
- [ ] 故意删掉 API Key 重试 → 看到友好错误提示
- [ ] 切换到 docker 部署形态 → MCP URL 自动变 `http://ragflow-cpu:9382/mcp`，重启 clawith-backend 后 DB 中 Tool 行 `mcp_server_url` 已被 upsert

---

## Section 9 / 实施顺序与范围内/外

### 实施顺序（依赖关系）

1. **基础设施**（Section 5/6）：dev.sh 加 MCP 进程 + docker-compose 解开 MCP 注释 → 验证 curl 能拿到 tools/list
2. **Tool seed**（Section 3）：`tool_seeder.py` 加 ragflow_retrieval 行（带 env-driven URL）→ 重启 Clawith 后端验 DB
3. **格式化层**（Section 4）：`agent_tools.py` 加 `_format_ragflow_response` + RAGFlow special-case → 单元测试
4. **错误兜底**（Section 8）：API Key 预检查 + timeout 注入 → 单元测试
5. **i18n**：`agent.toolCategories.knowledge` 双语
6. **手动冒烟**：完整走一遍验收 checklist

### 范围内 ✅

- 一个 MCP Tool 行：`ragflow_retrieval`
- per-Agent API Key 配置 UI（复用 Tavily 同款机制）
- 返回 markdown 格式化（含文件名/页码/相似度/doc_id/dataset_id）
- dev.sh + docker-compose 双形态启动 MCP server
- 友好错误兜底文案
- 单元 + 集成测试

### 范围外 ❌（明确排除，避免 scope creep）

- ❌ PDF 页面截图渲染
- ❌ Per-tenant 多用户隔离改造（host 模式天然分离，无需额外工作）
- ❌ list_datasets 显式工具
- ❌ Skill 脚本套件接入
- ❌ 检索参数暴露给 Agent
- ❌ MCP 端口对外公网暴露
- ❌ Sidebar SSO 流程改造（前置 plan 已完成）
- ❌ EnterpriseSettings 新增 "RAGFlow 配置"页面（API Key 在 Agent 级配置即可）
- ❌ Agent 模板自动追加 ragflow_retrieval（用户手动勾选）

---

## Self-Review Checklist

**Spec coverage：**
- 用户要求 1（仅检索） → Section 9 范围内/外明确
- 用户要求 2（仅 MCP，不接 Skill） → Section 9 范围外明确
- 用户要求 3（仅文本引用） → Section 4 格式化设计
- 用户要求 4（per-Agent API Key 复用 Tavily 机制） → Section 3.2 config_schema
- 用户要求 5（锁定参数） → Section 3.2 parameters_schema 仅 2 字段 + Section 4 不注入参数
- 用户要求 6（不补 list_datasets） → Section 9 范围外
- 用户要求 7（dev.sh 不用 docker；docker-compose 也要支持） → Section 5/6 双形态
- 用户要求 8（page_size 默认 30 不压缩） → Section 4 不覆盖默认参数

**Placeholder scan：**
- 没有"TODO/TBD/适当处理"占位
- Section 3.3 `seeder upsert 行为加固` 留了一个可执行的 acceptance criterion（"确认 mcp_server_url 在更新字段列表里"），由 plan 阶段验证现状决定具体改动

**Internal consistency：**
- `mcp_server_name="RAGFlow"`：Section 3.2 定义，Section 4.1/8.2/8.3 引用一致
- `ragflow_retrieval`：Section 3.2 命名，Section 4/8.4/8.7 引用一致
- `RAGFLOW_MCP_URL` 环境变量：Section 3.2/5.1/6/7.1 引用一致
- `host` mode：Section 2.1（compose `--mcp-mode=host`）+ 5.1（dev `--mode=host`）+ Section 1（架构链路）一致
- `--host=0.0.0.0`（docker）vs `--host=127.0.0.1`（dev）差异已在 Section 6 明确

**Ambiguity check：**
- Section 3.3 提到的 seeder upsert 现状未在 spec 阶段确认 — plan 阶段第一步应 grep 现有 `tool_seeder.py` 的 upsert 路径并视情况微调
- Section 8.5 单元测试用例 `test_ragflow_missing_api_key_returns_helpful_message` 的具体 mock 结构留给 plan 阶段细化（fixture 怎么搭）

**Scope check：**
- 整体改动量：~3 个文件主改（`tool_seeder.py` / `agent_tools.py` / `dev.sh`）+ 4 个文件配套改（`mcp_client.py` / `docker-compose.yml` / `ragflow/docker/docker-compose.yml` / `.env.example` 等）
- 新增文件：`tests/test_ragflow_mcp.py`
- 单 spec 单 plan 可执行，不需要拆分

---

## Execution Handoff

Spec 写完，**下一步 invoke writing-plans skill** 把这份 spec 转成可执行的 task-by-task plan，按 superpowers TDD/subagent 模式走。
