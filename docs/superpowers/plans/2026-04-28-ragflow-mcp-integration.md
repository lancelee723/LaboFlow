# RAGFlow MCP 集成 Clawith Agent — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`(推荐) 或 `superpowers:executing-plans`. 步骤用 `- [ ]` checkbox 跟踪。

**Goal:** 让 Clawith 的 Agent 通过 MCP 协议查询 RAGFlow 知识库，返回带文件名/页码/相似度的引用列表，复用现有 Tavily 同款 per-Agent API Key 配置 UI。

**Architecture:** RAGFlow MCP server 以 `--mode=host` 启动（dev 模式 venv 直跑、docker 模式同进程内启用），从请求 `Authorization` 头取 per-user API Key 鉴权。Clawith 端 seed 一条 type=mcp 的 Tool 行（URL 从 `RAGFLOW_MCP_URL` 环境变量读），调用后在 `_execute_mcp_tool` 里专门为 RAGFlow 做返回 markdown 格式化。

**Tech Stack:** Python 3.12 (FastAPI / SQLAlchemy / pytest), bash, Docker Compose, click（RAGFlow MCP CLI）

**Spec:** `docs/superpowers/specs/2026-04-28-ragflow-mcp-integration-design.md`

---

## Spec Deviations（plan 阶段确认现状后做的修订）

1. **`mcp_client.py` 不需要加 `timeout` 参数**。spec Section 8.3 假设默认 5s 是错的——实际默认 `timeout=30`（streamable）/ `timeout=60 if method=="tools/call" else 30`（sse），对 RAGFlow 完全够用。**取消 spec Section 8.3 的 mcp_client 改造**。

2. **`seed_builtin_tools` 必须加固以支持 type=mcp**（spec Section 3.3 留给 plan 阶段确认，现状是不支持）。具体：
   - 创建分支当前**写死 `type="builtin"`**，需改为 `type=t.get("type", "builtin")`，并附带 seed `mcp_server_url`/`mcp_server_name`/`mcp_tool_name`
   - 更新分支当前**不 sync** MCP 字段，需新增 sync 这三个字段（特别是 `mcp_server_url`，dev↔docker 切换会变）
   - 已分配在 Task 3 中。

---

## Files Overview

**新建：**
- `Clawith/backend/tests/test_ragflow_mcp.py` — 单元测试（_format_ragflow_response + seeder upsert）

**修改：**
- `Clawith/backend/app/services/agent_tools.py` — 加 `_format_ragflow_response` 函数 + `_execute_mcp_tool` 中的 RAGFlow special-case
- `Clawith/backend/app/services/tool_seeder.py` — seed `ragflow_retrieval` Tool 行 + 加固 upsert 支持 type=mcp
- `Clawith/frontend/src/i18n/en.json` — 新增 `agent.toolCategories.knowledge`
- `Clawith/frontend/src/i18n/zh.json` — 同上
- `dev.sh` — 启动 RAGFlow MCP server 进程 + 注入 `RAGFLOW_MCP_URL` 给 clawith-backend
- `stop.sh` — 端口扫描列表加 `$RAGFLOW_MCP_PORT`
- `setup-all.sh` — 加 RAGFlow MCP 模块/依赖 sanity check
- `.env.example` — 新增 `RAGFLOW_MCP_URL` / `RAGFLOW_MCP_PORT`
- `ragflow/docker/docker-compose.yml` — 解开 `--enable-mcpserver` 注释
- `ragflow/docker/.env` — 新增 `SVR_MCP_PORT=9382`
- `docker-compose.yml`（顶层）— `clawith-backend.environment` 注入 `RAGFLOW_MCP_URL=http://ragflow-cpu:9382/mcp`

---

## Pre-Flight

### Task 0: 摸底与基线验证

**Files:** 无文件改动，仅信息确认。

- [ ] **Step 0.1: 验证当前 main 干净 / RAGFlow 替换 LightRAG plan 的 working tree 改动状态**

```bash
cd /Users/lance/LaboFlow
git status --short
```
预期：看到 `M Clawith/backend/app/main.py`、`M Clawith/backend/app/services/tool_seeder.py`、`M Clawith/frontend/src/pages/Layout.tsx`、`M README.md`、`M dev.sh`、`M stop.sh` 等（来自前一 plan 未完成的工作）。**这些和本 plan 不冲突**——本 plan 在它们基础上叠加改动。

> **重要**：先不要切到 worktree。本次改动延续上一个 plan 的进展，在主工作树上推进即可。如果你倾向 worktree 隔离，自己决定（但要把上述 staged 改动一起 cherry-pick 过去）。

- [ ] **Step 0.2: 确认 RAGFlow MCP server 模块存在**

```bash
ls /Users/lance/LaboFlow/ragflow/mcp/server/server.py
/Users/lance/LaboFlow/ragflow/.venv/bin/python -c "import click, starlette; print('ok')"
```
预期：文件存在、依赖已装。

- [ ] **Step 0.3: 确认 ragflow venv 能直接 launch MCP server（不实际启动，只验证 --help）**

```bash
cd /Users/lance/LaboFlow/ragflow
PYTHONPATH=. .venv/bin/python mcp/server/server.py --help
```
预期：输出 click 帮助信息，含 `--base-url` `--host` `--port` `--mode` `--api-key` 等选项。**记录看到的 mode choices 是不是 ['self-host', 'host']**。

- [ ] **Step 0.4: 确认 dev.sh 当前工作正常**

```bash
./setup-all.sh && ./dev.sh
sleep 60
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9380/v1/system/version
./stop.sh
```
预期：第一行返回 `200`（RAGFlow API 健康）。**完成此步后回到干净状态**，不留进程。

---

## Phase 1 — Clawith backend：格式化层（先做，无环境依赖）

### Task 1: `_format_ragflow_response` 函数 + 单元测试

**Files:**
- Create: `Clawith/backend/tests/test_ragflow_mcp.py`
- Modify: `Clawith/backend/app/services/agent_tools.py`（在文件末尾或 `_execute_mcp_tool` 附近加新函数）

- [ ] **Step 1.1: 写测试文件（4 个用例）**

新建 `Clawith/backend/tests/test_ragflow_mcp.py`：

```python
"""Tests for RAGFlow MCP integration formatting + seeder behavior."""

import json
import importlib

import pytest


# ── _format_ragflow_response ─────────────────────────────────


def test_format_ragflow_normal_chunk():
    from app.services.agent_tools import _format_ragflow_response
    raw = json.dumps({
        "chunks": [
            {
                "content": "Sales grew 23% YoY driven by new EV models.",
                "similarity": 0.85,
                "document_keyword": "Q3-Report.pdf",
                "positions": [[12, 80, 120, 500, 300]],
                "dataset_name": "Customer Interviews",
                "document_id": "d1",
                "dataset_id": "s1",
            }
        ],
        "pagination": {"total_chunks": 1, "page": 1, "page_size": 30},
    })
    out = _format_ragflow_response(raw)
    assert "Q3-Report.pdf" in out
    assert "p.12" in out
    assert "85%" in out
    assert "Customer Interviews" in out
    assert "doc_id=d1" in out
    assert "dataset_id=s1" in out
    assert "Sales grew" in out


def test_format_ragflow_empty_chunks():
    from app.services.agent_tools import _format_ragflow_response
    out = _format_ragflow_response(json.dumps({"chunks": [], "pagination": {}}))
    assert "no relevant results" in out.lower()


def test_format_ragflow_malformed_json_falls_back_to_raw():
    from app.services.agent_tools import _format_ragflow_response
    raw = "this is not json"
    out = _format_ragflow_response(raw)
    assert out == raw


def test_format_ragflow_truncates_long_content():
    from app.services.agent_tools import _format_ragflow_response
    chunk = {
        "content": "x" * 1000,
        "similarity": 0.5,
        "document_keyword": "X.pdf",
        "dataset_name": "DS",
        "document_id": "d2",
        "dataset_id": "s2",
        "positions": [],
    }
    out = _format_ragflow_response(json.dumps({"chunks": [chunk], "pagination": {"total_chunks": 1}}))
    assert "…" in out  # ellipsis indicates truncation
    # content is 1000 chars truncated to 400 + ellipsis; total output well under 1500
    assert len(out) < 1500


def test_format_ragflow_handles_missing_optional_fields():
    """Chunks may omit positions, dataset_name, document_keyword on edge cases."""
    from app.services.agent_tools import _format_ragflow_response
    chunk = {"content": "minimal", "similarity": 0.3}
    out = _format_ragflow_response(json.dumps({"chunks": [chunk], "pagination": {}}))
    assert "(unknown doc)" in out
    assert "(unknown dataset)" in out
    assert "p." not in out  # no page since positions empty
```

- [ ] **Step 1.2: 跑测试（应 FAIL）**

```bash
cd /Users/lance/LaboFlow/Clawith/backend
.venv/bin/python -m pytest tests/test_ragflow_mcp.py -v
```
预期：5 用例全部 FAIL，报错 `ImportError: cannot import name '_format_ragflow_response'`。

- [ ] **Step 1.3: 实现 `_format_ragflow_response`**

打开 `Clawith/backend/app/services/agent_tools.py`，在文件末尾（在所有其他 `_*` 辅助函数之后、`_execute_mcp_tool` 函数之前；如果嫌找位置麻烦，直接放 `_execute_mcp_tool` 上面就行）插入：

```python
def _format_ragflow_response(raw: str) -> str:
    """Convert RAGFlow MCP retrieval JSON output into compact markdown citations.

    The MCP server returns a JSON string in TextContent. We unpack it,
    sort/preserve the chunks, and produce a markdown citation list that the
    LLM can read and quote back to the user. Doc/dataset IDs are kept as a
    trailing line so the LLM can scope follow-up queries by document.

    On any parse failure, the raw string is returned unchanged so the LLM
    still sees something rather than an opaque error.
    """
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw

    chunks = data.get("chunks", [])
    if not chunks:
        return "Knowledge base returned no relevant results for this query."

    pagination = data.get("pagination", {})
    total = pagination.get("total_chunks", len(chunks))

    lines = [
        f"Knowledge base returned {len(chunks)} chunks "
        f"(of {total} matching) — sorted by relevance:\n"
    ]

    for i, c in enumerate(chunks, 1):
        sim = c.get("similarity", 0)
        sim_pct = f"{int(sim * 100)}%"
        doc_name = c.get("document_keyword") or c.get("document_name") or "(unknown doc)"
        ds_name = c.get("dataset_name") or "(unknown dataset)"
        positions = c.get("positions") or []
        page = None
        if positions and isinstance(positions[0], list) and positions[0]:
            page = positions[0][0]
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

`json` 模块在文件顶部已 import (`import json`，第 17 行附近)，无需新增 import。

- [ ] **Step 1.4: 跑测试（应 PASS）**

```bash
cd /Users/lance/LaboFlow/Clawith/backend
.venv/bin/python -m pytest tests/test_ragflow_mcp.py -v
```
预期：5/5 PASS。

- [ ] **Step 1.5: Commit**

```bash
cd /Users/lance/LaboFlow
git add Clawith/backend/app/services/agent_tools.py Clawith/backend/tests/test_ragflow_mcp.py
git commit -m "$(cat <<'EOF'
feat(clawith-be): add _format_ragflow_response for RAGFlow MCP citations

Pure function that converts RAGFlow MCP retrieval JSON into compact
markdown citations (file/page/similarity + doc_id/dataset_id footnote
for follow-up scoping). Truncates chunk content to 400 chars; falls
back to raw on parse failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Clawith backend：dispatcher 改造

### Task 2: `_execute_mcp_tool` 加 RAGFlow special-case + API key 预检查

**Files:**
- Modify: `Clawith/backend/app/services/agent_tools.py`（在 `_execute_mcp_tool` 函数体内，约行 3614-3642 之间）

**位置参考**（**首步必须确认**——文件正在演进，行号可能漂移）：

- [ ] **Step 2.1: 重新定位 `_execute_mcp_tool` 函数体**

```bash
cd /Users/lance/LaboFlow/Clawith
grep -n "async def _execute_mcp_tool\|client = MCPClient\|return await client.call_tool" backend/app/services/agent_tools.py
```
预期：看到三处行号——函数定义、`MCPClient(...)` 创建、`return await client.call_tool(...)`。**记录这三个行号**，下面 step 用。

- [ ] **Step 2.2: 写测试（先红）**

在 `Clawith/backend/tests/test_ragflow_mcp.py` 末尾追加：

```python
# ── _execute_mcp_tool RAGFlow special-case ───────────────────


@pytest.mark.asyncio
async def test_ragflow_missing_api_key_returns_helpful_message(monkeypatch):
    """If the RAGFlow Tool exists but the agent has no api_key configured,
    we should return a friendly hint without hitting the network."""
    from app.services import agent_tools

    class FakeTool:
        name = "ragflow_retrieval"
        type = "mcp"
        mcp_server_url = "http://localhost:9382/mcp"
        mcp_server_name = "RAGFlow"
        mcp_tool_name = "ragflow_retrieval"
        config = {}
        id = 999

    class FakeAgentTool:
        config = {}  # no api_key

    class FakeResult:
        def scalar_one_or_none(self):
            return FakeResult.next_value
        next_value = None

    class FakeDB:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return None
        async def execute(self, _stmt):
            r = FakeResult()
            FakeResult.next_value = self._sequence.pop(0) if self._sequence else None
            return r
        def __init__(self, sequence):
            self._sequence = sequence

    # Monkeypatch async_session to yield Tool then AgentTool, then None
    fake_db = FakeDB([FakeTool(), FakeAgentTool()])
    monkeypatch.setattr(agent_tools, "async_session", lambda: fake_db)

    # Monkeypatch MCPClient — must NOT be called when api_key missing
    called = {"hit": False}
    class FakeMCP:
        def __init__(self, *a, **kw): called["hit"] = True
        async def call_tool(self, *a, **kw): return ""
    monkeypatch.setattr("app.services.mcp_client.MCPClient", FakeMCP)

    result = await agent_tools._execute_mcp_tool(
        "ragflow_retrieval", {"question": "test"}, agent_id=1
    )
    assert "no RAGFlow API key" in result.lower() or "api key" in result.lower()
    assert called["hit"] is False, "MCPClient should not be created when api_key missing"
```

> **测试注释**：这个测试用 monkey-patch 替换 `async_session` 和 `MCPClient`，避免依赖真实 DB 和网络。`FakeDB` 模拟 SQLAlchemy session 的 `execute().scalar_one_or_none()` 链式调用，按顺序吐出 Tool → AgentTool。

- [ ] **Step 2.3: 跑测试（应 FAIL）**

```bash
cd /Users/lance/LaboFlow/Clawith/backend
.venv/bin/python -m pytest tests/test_ragflow_mcp.py::test_ragflow_missing_api_key_returns_helpful_message -v
```
预期：FAIL（当前会 hit MCPClient 或返回 connection error，不会返回 "no RAGFlow API key"）。

- [ ] **Step 2.4: 修改 `_execute_mcp_tool`**

打开 `Clawith/backend/app/services/agent_tools.py`，找到（参考 Step 2.1 的行号）这一段：

```python
        # Detect Smithery-hosted MCP servers (*.run.tools URLs)
        # These need Smithery Connect to route tool calls
        if ".run.tools" in mcp_url and merged_config:
            return await _execute_via_smithery_connect(mcp_url, mcp_name, arguments, merged_config, agent_id=agent_id)

        # Direct MCP call for non-Smithery servers
        # Priority for API key:
        # 1. Per-agent tool config (api_key / atlassian_api_key)
        # 2. Agent's Atlassian channel config (for atlassian_* tools)
        direct_api_key = merged_config.get("api_key") or merged_config.get("atlassian_api_key")
        if not direct_api_key and tool.mcp_server_name == "Atlassian Rovo":
            try:
                from app.api.atlassian import get_atlassian_api_key_for_agent
                direct_api_key = await get_atlassian_api_key_for_agent(agent_id)
            except Exception:
                pass
        client = MCPClient(mcp_url, api_key=direct_api_key)
        return await client.call_tool(mcp_name, arguments)
```

修改为（**两处插入**——RAGFlow API Key preflight + 返回格式化）：

```python
        # Detect Smithery-hosted MCP servers (*.run.tools URLs)
        # These need Smithery Connect to route tool calls
        if ".run.tools" in mcp_url and merged_config:
            return await _execute_via_smithery_connect(mcp_url, mcp_name, arguments, merged_config, agent_id=agent_id)

        # Direct MCP call for non-Smithery servers
        # Priority for API key:
        # 1. Per-agent tool config (api_key / atlassian_api_key)
        # 2. Agent's Atlassian channel config (for atlassian_* tools)
        direct_api_key = merged_config.get("api_key") or merged_config.get("atlassian_api_key")
        if not direct_api_key and tool.mcp_server_name == "Atlassian Rovo":
            try:
                from app.api.atlassian import get_atlassian_api_key_for_agent
                direct_api_key = await get_atlassian_api_key_for_agent(agent_id)
            except Exception:
                pass

        # ── RAGFlow special-case: friendly preflight when api_key missing ──
        if tool.mcp_server_name == "RAGFlow" and not direct_api_key:
            return (
                "❌ This agent has no RAGFlow API key configured. "
                "Open Agent settings → RAGFlow Retrieval → paste your API Key. "
                "Generate one via the Knowledge Base sidebar (RAGFlow Profile → API Keys)."
            )

        client = MCPClient(mcp_url, api_key=direct_api_key)
        raw = await client.call_tool(mcp_name, arguments)

        # ── RAGFlow special-case: format JSON → markdown citations ──
        if tool.mcp_server_name == "RAGFlow":
            return _format_ragflow_response(raw)
        return raw
```

- [ ] **Step 2.5: 跑测试（应 PASS）**

```bash
cd /Users/lance/LaboFlow/Clawith/backend
.venv/bin/python -m pytest tests/test_ragflow_mcp.py -v
```
预期：6/6 PASS（5 个 format + 1 个 preflight）。

- [ ] **Step 2.6: Commit**

```bash
cd /Users/lance/LaboFlow
git add Clawith/backend/app/services/agent_tools.py Clawith/backend/tests/test_ragflow_mcp.py
git commit -m "$(cat <<'EOF'
feat(clawith-be): RAGFlow MCP dispatch — preflight api_key + format response

In _execute_mcp_tool, when tool.mcp_server_name == "RAGFlow":
- Skip the network call and return a friendly hint if no api_key is set
- After call_tool, run _format_ragflow_response to convert raw JSON
  into markdown citations the LLM can quote back to the user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Clawith backend：seeder + 加固 upsert

### Task 3: `tool_seeder.py` 加 RAGFlow Tool seed + 加固 upsert 支持 type=mcp

**Files:**
- Modify: `Clawith/backend/app/services/tool_seeder.py`
  - 加固 `seed_builtin_tools()` 函数（行 2351-2437 之间）使其支持 type=mcp 工具的 create+upsert
  - 在 `BUILTIN_TOOLS` 列表（行 2342 附近）追加 RAGFlow Tool 条目

- [ ] **Step 3.1: 写测试（先红）**

在 `Clawith/backend/tests/test_ragflow_mcp.py` 末尾追加：

```python
# ── tool_seeder seed entry ────────────────────────────────────


def test_seeder_includes_ragflow_with_env_url(monkeypatch):
    """RAGFlow Tool entry must read mcp_server_url from env at module load."""
    monkeypatch.setenv("RAGFLOW_MCP_URL", "http://test-host:9382/mcp")
    from app.services import tool_seeder
    importlib.reload(tool_seeder)
    ragflow_tool = next(
        (t for t in tool_seeder.BUILTIN_TOOLS if t["name"] == "ragflow_retrieval"),
        None,
    )
    assert ragflow_tool is not None, "ragflow_retrieval not found in BUILTIN_TOOLS"
    assert ragflow_tool["type"] == "mcp"
    assert ragflow_tool["mcp_server_url"] == "http://test-host:9382/mcp"
    assert ragflow_tool["mcp_tool_name"] == "ragflow_retrieval"
    assert ragflow_tool["mcp_server_name"] == "RAGFlow"
    assert ragflow_tool["category"] == "knowledge"
    assert ragflow_tool["is_default"] is False
    # parameters_schema must expose only question + dataset_ids (locked-down per spec)
    props = ragflow_tool["parameters_schema"]["properties"]
    assert set(props.keys()) == {"question", "dataset_ids"}
    # config_schema must declare api_key as password field
    fields = ragflow_tool["config_schema"]["fields"]
    api_key_field = next((f for f in fields if f["key"] == "api_key"), None)
    assert api_key_field is not None
    assert api_key_field["type"] == "password"


def test_seeder_default_url_when_env_unset(monkeypatch):
    monkeypatch.delenv("RAGFLOW_MCP_URL", raising=False)
    from app.services import tool_seeder
    importlib.reload(tool_seeder)
    ragflow_tool = next(t for t in tool_seeder.BUILTIN_TOOLS if t["name"] == "ragflow_retrieval")
    assert ragflow_tool["mcp_server_url"] == "http://localhost:9382/mcp"
```

- [ ] **Step 3.2: 跑测试（应 FAIL）**

```bash
cd /Users/lance/LaboFlow/Clawith/backend
.venv/bin/python -m pytest tests/test_ragflow_mcp.py::test_seeder_includes_ragflow_with_env_url tests/test_ragflow_mcp.py::test_seeder_default_url_when_env_unset -v
```
预期：2 用例 FAIL（`StopIteration` 因为列表里还没有 ragflow_retrieval）。

- [ ] **Step 3.3: 加固 `seed_builtin_tools` 支持 type=mcp**

打开 `Clawith/backend/app/services/tool_seeder.py`，定位 `async def seed_builtin_tools()` 函数（约行 2351）。

**(a) 修改创建分支（约行 2362-2374）**——把当前的：

```python
            if not existing:
                tool = Tool(
                    name=t["name"],
                    display_name=t["display_name"],
                    description=t["description"],
                    type="builtin",
                    category=t["category"],
                    icon=t["icon"],
                    is_default=t["is_default"],
                    parameters_schema=t.get("parameters_schema", {"type": "object", "properties": {}}),
                    config=t.get("config", {}),
                    config_schema=t.get("config_schema", {}),
                    source="builtin",
                )
                db.add(tool)
```

改为：

```python
            if not existing:
                tool = Tool(
                    name=t["name"],
                    display_name=t["display_name"],
                    description=t["description"],
                    type=t.get("type", "builtin"),
                    category=t["category"],
                    icon=t["icon"],
                    is_default=t["is_default"],
                    parameters_schema=t.get("parameters_schema", {"type": "object", "properties": {}}),
                    config=t.get("config", {}),
                    config_schema=t.get("config_schema", {}),
                    source="builtin",
                    mcp_server_url=t.get("mcp_server_url"),
                    mcp_server_name=t.get("mcp_server_name"),
                    mcp_tool_name=t.get("mcp_tool_name"),
                )
                db.add(tool)
```

**(b) 修改更新分支（约行 2380-2409）**——在 `if existing.parameters_schema != t["parameters_schema"]:` 块**之后**、`if updated_fields:` 块**之前**插入新增的 MCP 字段 sync 块：

```python
                if existing.parameters_schema != t["parameters_schema"]:
                    existing.parameters_schema = t["parameters_schema"]
                    updated_fields.append("parameters_schema")
                # ── MCP fields sync (for type=mcp tools whose URL may shift across deploy modes) ──
                if t.get("type") == "mcp":
                    if existing.type != "mcp":
                        existing.type = "mcp"
                        updated_fields.append("type")
                    if existing.mcp_server_url != t.get("mcp_server_url"):
                        existing.mcp_server_url = t.get("mcp_server_url")
                        updated_fields.append("mcp_server_url")
                    if existing.mcp_server_name != t.get("mcp_server_name"):
                        existing.mcp_server_name = t.get("mcp_server_name")
                        updated_fields.append("mcp_server_name")
                    if existing.mcp_tool_name != t.get("mcp_tool_name"):
                        existing.mcp_tool_name = t.get("mcp_tool_name")
                        updated_fields.append("mcp_tool_name")
                if updated_fields:
                    logger.info(f"[ToolSeeder] Updated {', '.join(updated_fields)}: {t['name']}")
```

> 注意保留原 `if updated_fields:` 块——只是它前面新增了一段 MCP sync。

- [ ] **Step 3.4: 在 `BUILTIN_TOOLS` 列表追加 RAGFlow Tool 条目**

打开 `Clawith/backend/app/services/tool_seeder.py`，在文件**顶部 import 段**（约行 1-8）加上 `import os`（如果尚未 import）。先确认：

```bash
head -10 /Users/lance/LaboFlow/Clawith/backend/app/services/tool_seeder.py
```
若已有 `import os` 跳过；否则在 import 段新增一行。

然后定位 `BUILTIN_TOOLS = [` （行 2342 附近——即 merge 后的总列表声明）。**注意**有两处 `BUILTIN_TOOLS`：
- 行 9：初始定义（包含 file/aware/communication/search 等"内置工具组"）
- 行 2342：合并后的总列表（`*BUILTIN_TOOLS, *XXX_TOOLS, ...`）

把 RAGFlow 加到行 2342 附近的总列表里——具体做法是**在合并定义之前再单独定义一个 RAGFLOW_TOOLS 列表**：

在 `# Merge all tool lists into the final BUILTIN_TOOLS` 注释行**之前**插入：

```python
# ── RAGFlow MCP tool (Knowledge Base retrieval) ──────────────────
RAGFLOW_TOOLS = [
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
                        "determines which RAGFlow account's datasets the agent can search."
                    ),
                },
            ]
        },
    },
]
```

然后在 `BUILTIN_TOOLS = [\n    *BUILTIN_TOOLS,\n    *...,\n]` 的 splat 列表里追加 `*RAGFLOW_TOOLS,`：

```python
BUILTIN_TOOLS = [
    *BUILTIN_TOOLS,
    # ... 既有的其他 *XXX_TOOLS spreads ...
    *RAGFLOW_TOOLS,
]
```

> **务必看清楚**：行 2342 那个 `BUILTIN_TOOLS` 用 `*splat` 把所有子列表合并。把 `*RAGFLOW_TOOLS,` 加到这个 splat 列表的末尾。

- [ ] **Step 3.5: 跑测试（应 PASS）**

```bash
cd /Users/lance/LaboFlow/Clawith/backend
.venv/bin/python -m pytest tests/test_ragflow_mcp.py -v
```
预期：8/8 PASS。

- [ ] **Step 3.6: Commit**

```bash
cd /Users/lance/LaboFlow
git add Clawith/backend/app/services/tool_seeder.py Clawith/backend/tests/test_ragflow_mcp.py
git commit -m "$(cat <<'EOF'
feat(clawith-be): seed ragflow_retrieval MCP tool + harden seeder for type=mcp

- Add RAGFLOW_TOOLS list with one MCP tool (mcp_server_url read from
  RAGFLOW_MCP_URL env, defaults to http://localhost:9382/mcp).
- Lock parameters_schema to {question, dataset_ids} per spec; hide
  page_size/similarity_threshold/etc from the LLM.
- config_schema declares api_key as password field — reuses Tavily-style
  encrypted UI flow.
- seed_builtin_tools now respects t["type"] (was hard-coded "builtin"),
  seeds mcp_server_url/name/tool_name on create, and syncs them on
  update so dev↔docker URL switches propagate without manual DB edits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: i18n — `agent.toolCategories.knowledge`

**Files:**
- Modify: `Clawith/frontend/src/i18n/en.json`（行 612 附近的 `toolCategories` 对象）
- Modify: `Clawith/frontend/src/i18n/zh.json`（对应位置）

- [ ] **Step 4.1: 修改 en.json**

打开 `Clawith/frontend/src/i18n/en.json`，找到行 612 附近的：

```json
    "toolCategories": {
      "file": "File Operations",
      "task": "Task Management",
      "communication": "Communication",
      "search": "Search",
      "custom": "Custom",
      "general": "General",
      "email": "Email",
      "aware": "Aware & Triggers",
      "social": "Social",
      "code": "Code & Execution",
      "discovery": "Discovery",
      "feishu": "Feishu / Lark",
      "agentbay": "AgentBay"
    },
```

在 `"agentbay": "AgentBay"` 行**之前**插入一行（注意 JSON 逗号——前一行末尾要加逗号）：

```json
      "agentbay": "AgentBay",
      "knowledge": "Knowledge Base"
```

> 不要忘记 `"agentbay"` 行末尾的逗号。

- [ ] **Step 4.2: 修改 zh.json**

```bash
grep -n "toolCategories" /Users/lance/LaboFlow/Clawith/frontend/src/i18n/zh.json
```
找到 `agent.toolCategories` 那个对象（用第一处出现，对应 en.json 行 612 的位置）。在 `"agentbay"` 那行后追加 `"knowledge": "知识库"`，规则同 en.json。

如果 zh.json 缺少其他 category 的中文翻译（比如 agentbay/feishu 等），不要扩大修改——本任务只加 knowledge。

- [ ] **Step 4.3: 类型检查（确认 JSON 合法）**

```bash
cd /Users/lance/LaboFlow/Clawith/frontend
node -e "JSON.parse(require('fs').readFileSync('src/i18n/en.json'))"
node -e "JSON.parse(require('fs').readFileSync('src/i18n/zh.json'))"
```
预期：两条命令都无输出（JSON 合法）。如有 `SyntaxError: Unexpected token` 报错，是逗号或括号问题——重新检查 Step 4.1/4.2 的修改位置。

- [ ] **Step 4.4: Commit**

```bash
cd /Users/lance/LaboFlow
git add Clawith/frontend/src/i18n/en.json Clawith/frontend/src/i18n/zh.json
git commit -m "$(cat <<'EOF'
feat(clawith-fe): add 'knowledge' tool category i18n for RAGFlow Retrieval

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Dev 模式启动 MCP server

### Task 5: dev.sh / stop.sh / .env.example / setup-all.sh

**Files:**
- Modify: `dev.sh`
- Modify: `stop.sh`
- Modify: `.env.example`
- Modify: `setup-all.sh`

- [ ] **Step 5.1: dev.sh — 顶部端口变量段加 RAGFLOW_MCP_PORT**

打开 `/Users/lance/LaboFlow/dev.sh`，找到行 90 附近：

```bash
: "${RAGFLOW_PORT:=8880}"
: "${AIPPT_PORT:=5173}"
```

在 `RAGFLOW_PORT` 行**后面**新增一行：

```bash
: "${RAGFLOW_PORT:=8880}"
: "${RAGFLOW_MCP_PORT:=9382}"
: "${AIPPT_PORT:=5173}"
```

- [ ] **Step 5.2: dev.sh — Pre-flight cleanup 端口扫描列表加 `$RAGFLOW_MCP_PORT`**

找到行 127（`for port in $NGINX_PORT $CLAWITH_FRONTEND_PORT $CLAWITH_BACKEND_PORT $RAGFLOW_PORT $AIPPT_PORT; do`），改为：

```bash
for port in $NGINX_PORT $CLAWITH_FRONTEND_PORT $CLAWITH_BACKEND_PORT $RAGFLOW_PORT $RAGFLOW_MCP_PORT $AIPPT_PORT; do
```

- [ ] **Step 5.3: dev.sh — Clawith backend 启动段注入 `RAGFLOW_MCP_URL`**

找到行 140-146 附近的 Clawith backend 启动 nohup 块：

```bash
nohup env PYTHONUNBUFFERED=1 \
    JWT_SECRET_KEY="$JWT_SECRET_KEY" \
    DATABASE_URL="$DATABASE_URL" \
    PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
    .venv/bin/uvicorn app.main:app \
        --host 0.0.0.0 --port "$CLAWITH_BACKEND_PORT" --reload \
    > "$LOG_DIR/clawith-backend.log" 2>&1 &
```

在 `PUBLIC_BASE_URL=...` 行后面追加 `RAGFLOW_MCP_URL=...` 注入：

```bash
nohup env PYTHONUNBUFFERED=1 \
    JWT_SECRET_KEY="$JWT_SECRET_KEY" \
    DATABASE_URL="$DATABASE_URL" \
    PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
    RAGFLOW_MCP_URL="${RAGFLOW_MCP_URL:-http://localhost:$RAGFLOW_MCP_PORT/mcp}" \
    .venv/bin/uvicorn app.main:app \
        --host 0.0.0.0 --port "$CLAWITH_BACKEND_PORT" --reload \
    > "$LOG_DIR/clawith-backend.log" 2>&1 &
```

- [ ] **Step 5.4: dev.sh — 在 task_executor 启动后、web frontend 启动前插入 MCP server 启动**

定位行 197-204（task_executor nohup 块）。在 task_executor `cd "$ROOT"` 之后、行 206 `log "Starting RAGFlow web frontend..."` 之前，**插入新段**：

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

- [ ] **Step 5.5: dev.sh — wait_port 段加 RAGFlow MCP**

找到 wait_port 段（行 244-247 附近）：

```bash
wait_port "$CLAWITH_BACKEND_PORT"  "Clawith backend"  30 || true
wait_port "$CLAWITH_FRONTEND_PORT" "Clawith frontend" 20 || true
wait_port "$RAGFLOW_PORT"          "RAGFlow"          180 || true
wait_port "$AIPPT_PORT"            "AIPPT"            20 || true
```

在 `RAGFLOW_PORT` 行后面追加：

```bash
wait_port "$RAGFLOW_PORT"          "RAGFlow"          180 || true
wait_port "$RAGFLOW_MCP_PORT"      "RAGFlow MCP"      30  || true
wait_port "$AIPPT_PORT"            "AIPPT"            20 || true
```

- [ ] **Step 5.6: dev.sh — Summary debug 区追加一行**

找到行 275-279 附近的 Direct access 块：

```bash
echo -e "  ${CYAN}Direct access (debugging):${NC}"
echo -e "    Clawith frontend  http://localhost:$CLAWITH_FRONTEND_PORT"
echo -e "    Clawith backend   http://localhost:$CLAWITH_BACKEND_PORT/api/health"
echo -e "    RAGFlow           http://localhost:$RAGFLOW_PORT"
echo -e "    AIPPT             http://localhost:$AIPPT_PORT"
```

在 RAGFlow 那行后面追加：

```bash
echo -e "    RAGFlow           http://localhost:$RAGFLOW_PORT"
echo -e "    RAGFlow MCP       http://localhost:$RAGFLOW_MCP_PORT/mcp  (server-to-server)"
echo -e "    AIPPT             http://localhost:$AIPPT_PORT"
```

- [ ] **Step 5.7: dev.sh — bash 语法检查**

```bash
bash -n /Users/lance/LaboFlow/dev.sh
```
预期：无输出。

- [ ] **Step 5.8: stop.sh — 端口扫描列表加 `$RAGFLOW_MCP_PORT`**

```bash
grep -n "RAGFLOW_PORT\|for port" /Users/lance/LaboFlow/stop.sh | head -10
```

打开 `stop.sh`，找到顶部 `: "${RAGFLOW_PORT:=8880}"` 那行，下面新增：

```bash
: "${RAGFLOW_MCP_PORT:=9382}"
```

找到端口扫描循环（类似 `for port in ... $RAGFLOW_PORT ...`），把 `$RAGFLOW_MCP_PORT` 加进去。

> 由于 stop.sh 也按 PID 文件循环 kill，新增的 `$PID_DIR/ragflow-mcp.pid` 会自动被处理，无需额外代码。

- [ ] **Step 5.9: stop.sh — bash 语法检查**

```bash
bash -n /Users/lance/LaboFlow/stop.sh
```
预期：无输出。

- [ ] **Step 5.10: .env.example — 新增 RAGFLOW_MCP_* 段**

打开 `/Users/lance/LaboFlow/.env.example`，在 `RAGFLOW_PORT=` 那行附近（或文件末尾）追加：

```bash
# ─── RAGFlow MCP (server-to-server, internal) ────────
# Dev mode: dev.sh launches RAGFlow MCP server at localhost:9382 directly.
# Docker mode: top-level docker-compose.yml overrides this to
#              http://ragflow-cpu:9382/mcp via clawith-backend.environment.
# Per-user API keys are configured per-Agent in Clawith UI (like Tavily).
RAGFLOW_MCP_URL=http://localhost:9382/mcp
RAGFLOW_MCP_PORT=9382
```

如果 `.env`（实际文件）已存在，**也同步追加**这两行——否则 dev.sh 启动时不会读到。

```bash
grep -q "^RAGFLOW_MCP_URL" /Users/lance/LaboFlow/.env || cat >> /Users/lance/LaboFlow/.env <<'EOF'

# ─── RAGFlow MCP (server-to-server, internal) ────────
RAGFLOW_MCP_URL=http://localhost:9382/mcp
RAGFLOW_MCP_PORT=9382
EOF
```

- [ ] **Step 5.11: setup-all.sh — 加 RAGFlow MCP sanity check**

打开 `setup-all.sh`，定位 RAGFlow 段（搜 `[4/5] RAGFlow` 或类似）。在该段末尾追加：

```bash
# RAGFlow MCP module sanity check
if [ -f "$ROOT/ragflow/mcp/server/server.py" ]; then
    ok "RAGFlow MCP server script present"
    if [ -f "$ROOT/ragflow/.venv/bin/python" ] && \
       "$ROOT/ragflow/.venv/bin/python" -c "import click, starlette" 2>/dev/null; then
        ok "RAGFlow MCP dependencies installed"
    else
        warn "RAGFlow MCP deps may be missing — re-run 'cd ragflow && uv sync --all-extras'"
    fi
else
    warn "ragflow/mcp/server/server.py missing — RAGFlow checkout incomplete"
fi

# Verify docker-compose has MCP enabled (production deploy readiness, optional)
if grep -q "^[[:space:]]*- --enable-mcpserver" "$ROOT/ragflow/docker/docker-compose.yml" 2>/dev/null; then
    ok "RAGFlow MCP enabled in docker-compose (production deploy ready)"
else
    warn "RAGFlow MCP NOT enabled in docker-compose.yml — fine for dev, required for docker prod deploy"
fi
```

> 如果你看到 setup-all.sh 用的辅助函数名不是 `ok`/`warn`（比如是 `say_ok`/`say_warn`），按实际名字替换。

- [ ] **Step 5.12: setup-all.sh — bash 语法检查**

```bash
bash -n /Users/lance/LaboFlow/setup-all.sh
```
预期：无输出。

- [ ] **Step 5.13: 端到端启动验证**

```bash
cd /Users/lance/LaboFlow
./stop.sh || true
./dev.sh
sleep 60
# 验证 4 个 RAGFlow 进程
lsof -iTCP:9380 -iTCP:9382 -iTCP:8880 -sTCP:LISTEN 2>/dev/null | head -10
ls .data/pid/ragflow-*.pid
# 验证 MCP server 响应（initialize）
curl -s -i http://localhost:9382/mcp -H "Content-Type: application/json" \
  -H "Authorization: Bearer fake-key-for-test" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2024-11-05","capabilities":{},
                 "clientInfo":{"name":"test","version":"1.0"}}}' | head -5
```
预期：
- `lsof` 输出包含 9380/9382/8880 三个端口
- `.data/pid/` 含 `ragflow-api.pid` / `ragflow-task-executor.pid` / `ragflow-mcp.pid` / `ragflow-web.pid`
- `curl` 返回 HTTP 200 或 401（401 因为 fake key——证明 MCP server 跑起来了且 host 模式生效）

如果 9382 端口没监听：

```bash
tail -50 .data/log/ragflow-mcp.log
```
检查启动错误。常见问题：`server.py` 不接受某个参数（看 Step 0.3 真实 `--help` 输出）；`.venv` 缺包（重跑 `uv sync --all-extras`）。

- [ ] **Step 5.14: 关闭服务**

```bash
./stop.sh
lsof -iTCP:9382 -sTCP:LISTEN
```
预期：第二条命令无输出（端口已释放）。

- [ ] **Step 5.15: Commit**

```bash
cd /Users/lance/LaboFlow
git add dev.sh stop.sh .env.example setup-all.sh
git commit -m "$(cat <<'EOF'
feat(scripts): launch RAGFlow MCP server in dev mode (venv, port 9382)

- dev.sh: start mcp/server/server.py --mode=host as a 4th RAGFlow
  process (api + task_executor + web + mcp), bound to 127.0.0.1:9382;
  inject RAGFLOW_MCP_URL into clawith-backend env so the seeder picks
  the right URL.
- stop.sh: ragflow-mcp.pid is auto-handled by PID-file loop; only port
  cleanup list extended.
- setup-all.sh: sanity-check MCP module + deps + docker-compose readiness.
- .env.example: document RAGFLOW_MCP_URL / RAGFLOW_MCP_PORT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — 生产部署（docker-compose）启用 MCP

### Task 6: ragflow/docker + 顶层 docker-compose.yml

**Files:**
- Modify: `ragflow/docker/docker-compose.yml`（解开 ragflow-cpu 段的 `--enable-mcpserver` 注释）
- Modify: `ragflow/docker/.env`（新增 `SVR_MCP_PORT=9382`）
- Modify: `docker-compose.yml`（顶层）（在 clawith-backend 段加 environment 注入）

- [ ] **Step 6.1: ragflow/docker/docker-compose.yml — 解开 ragflow-cpu 的 MCP command 注释**

```bash
grep -n "enable-mcpserver\|mcp-host\|mcp-port\|mcp-mode" /Users/lance/LaboFlow/ragflow/docker/docker-compose.yml | head -20
```
预期：看到 ragflow-cpu 和 ragflow-gpu 两个 service 各自有一组注释行（`# - --enable-mcpserver` 等）。

打开 `ragflow/docker/docker-compose.yml`，定位 **`ragflow-cpu` 段**（不是 ragflow-gpu）的 MCP 注释。把这几行：

```yaml
    #   - --enable-mcpserver
    #   - --mcp-host=0.0.0.0
    #   - --mcp-port=9382
    #   - --mcp-base-url=http://127.0.0.1:9380
    #   - --mcp-script-path=/ragflow/mcp/server/server.py
    #   - --mcp-mode=self-host
    #   - --mcp-host-api-key=ragflow-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

改为（去掉注释 + 改 mode + 删除 host-api-key 那行）：

```yaml
      - --enable-mcpserver
      - --mcp-host=0.0.0.0
      - --mcp-port=9382
      - --mcp-base-url=http://127.0.0.1:9380
      - --mcp-script-path=/ragflow/mcp/server/server.py
      - --mcp-mode=host
```

> **务必注意缩进**：YAML command 数组缩进是 6 空格 + `- `（参考同段已有的非注释 command 项）。

**端口暴露**：找到同 service 的 `ports:` 段，把：

```yaml
      - ${SVR_MCP_PORT}:9382 # entry for MCP (host_port:docker_port). The docker_port must match the value you set for `mcp-port` above.
```

如果当前是注释（`# - ${SVR_MCP_PORT}:9382 ...`），去掉前面 `#`。

- [ ] **Step 6.2: ragflow/docker/.env — 新增 SVR_MCP_PORT**

```bash
grep -q "^SVR_MCP_PORT" /Users/lance/LaboFlow/ragflow/docker/.env || cat >> /Users/lance/LaboFlow/ragflow/docker/.env <<'EOF'

# ─── MCP server port (host-side bind, optional for debugging) ───
SVR_MCP_PORT=9382
EOF
```

- [ ] **Step 6.3: 顶层 docker-compose.yml — clawith-backend 注入 RAGFLOW_MCP_URL**

```bash
grep -n "clawith-backend\|environment:" /Users/lance/LaboFlow/docker-compose.yml | head -20
```

打开 `/Users/lance/LaboFlow/docker-compose.yml`，定位 `clawith-backend:` service（注意是顶层文件，不是 Clawith 自己的 docker-compose）。

如果该 service 已有 `environment:` 段，在其下追加一行：

```yaml
    environment:
      # ... 既有项 ...
      RAGFLOW_MCP_URL: http://ragflow-cpu:9382/mcp
```

如果没有 `environment:` 段，新增：

```yaml
    environment:
      RAGFLOW_MCP_URL: http://ragflow-cpu:9382/mcp
```

- [ ] **Step 6.4: 验证 docker-compose 配置合法**

```bash
cd /Users/lance/LaboFlow
docker compose config -q
```
预期：无报错。如果报错 `service ragflow-cpu has invalid type for "command"`，检查 Step 6.1 的缩进。

```bash
docker compose -f ragflow/docker/docker-compose.yml config -q
```
预期：无报错。

- [ ] **Step 6.5: Commit**

```bash
cd /Users/lance/LaboFlow
git add ragflow/docker/docker-compose.yml ragflow/docker/.env docker-compose.yml
git commit -m "$(cat <<'EOF'
feat(compose): enable RAGFlow MCP server (host mode) for production deploy

- ragflow/docker/docker-compose.yml: uncomment --enable-mcpserver block
  in ragflow-cpu, switch --mcp-mode from self-host to host (per-user
  api_key from Authorization header), drop --mcp-host-api-key.
- Expose ${SVR_MCP_PORT}:9382 (host-side, optional for debugging).
- Top-level docker-compose.yml: inject RAGFLOW_MCP_URL into clawith-backend
  pointing at the docker network address (ragflow-cpu:9382/mcp), so the
  seeder picks the correct URL when running in compose mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — End-to-End 验收

### Task 7: 完整链路冒烟测试

**Files:** 无文件改动；本任务仅人工验收 + 记录。

- [ ] **Step 7.1: 干净启动 dev 模式**

```bash
cd /Users/lance/LaboFlow
./stop.sh || true
./dev.sh
sleep 90
```

预期：summary 显示 4 个 RAGFlow 端点（API/Web/MCP），Clawith backend、frontend、AIPPT、NGINX 都健康。

- [ ] **Step 7.2: 验证 Clawith backend 已 seed RAGFlow Tool 行**

```bash
# 查 Clawith backend 启动日志，看 ToolSeeder 是否 log 了 ragflow_retrieval
grep -i "ragflow_retrieval\|RAGFlow" /Users/lance/LaboFlow/.data/log/clawith-backend.log | head -10
```
预期：看到 `[ToolSeeder] Created builtin tool: ragflow_retrieval`（首次启动）或 `[ToolSeeder] Updated mcp_server_url: ragflow_retrieval`（再次启动）。

直接查 DB（如果 sqlite/postgres 可达）：
```bash
# Postgres 示例（按实际 DATABASE_URL 调整）
psql "$DATABASE_URL" -c "SELECT name, type, mcp_server_url, mcp_tool_name, mcp_server_name FROM tools WHERE name='ragflow_retrieval';"
```
预期：1 行，`type=mcp`、`mcp_server_url=http://localhost:9382/mcp`、`mcp_tool_name=ragflow_retrieval`、`mcp_server_name=RAGFlow`。

- [ ] **Step 7.3: 在 RAGFlow Web 创建测试数据集 + 上传 PDF**

打开 http://localhost:3008（NGINX 入口）→ 点 Sidebar "Knowledge Base" → SSO 跳到 RAGFlow → 在 RAGFlow Web UI：
1. 登录（用 SSO token 已自动登录）
2. 创建 dataset（名字写有意义的，比如 `Test KB`，description 写 `咨询测试用知识库，包含示例报告`）
3. 上传任一 PDF（建议 1-3 页的小文档，方便冒烟）
4. 点 "Parse" 等待解析完成（通常 30-90 秒）

确认：dataset 列表中该 dataset `chunks` > 0。

- [ ] **Step 7.4: 在 RAGFlow Profile 生成 API Key**

在 RAGFlow Web UI 右上角点头像 → Profile → API Keys → Create new key → 复制（格式 `ragflow-xxxxxxxxxxxx...`）。

- [ ] **Step 7.5: 用 curl 直接验证 MCP server 能用这个 key 检索**

```bash
RAGFLOW_KEY="<paste-the-key-from-7.4>"
# 列工具
curl -s http://localhost:9382/mcp -H "Authorization: Bearer $RAGFLOW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -30
```
预期：返回 JSON 含 `ragflow_retrieval`，`description` 字段嵌入了 Step 7.3 创建的 dataset 名字 + ID。

```bash
# 检索
curl -s http://localhost:9382/mcp -H "Authorization: Bearer $RAGFLOW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"ragflow_retrieval","arguments":{"question":"<你 PDF 里的某个关键词>"}}}'
```
预期：返回 200，JSON 中 `chunks` 数组非空，每个 chunk 含 `content`/`similarity`/`document_keyword`/`positions`。

- [ ] **Step 7.6: 在 Clawith UI 创建 Agent 并配置 RAGFlow Retrieval**

打开 http://localhost:3008，登录 → 创建新 Agent（任意名字） → 进入 Agent 编辑页 → 工具列表 → 找到"知识库"分类下的 "RAGFlow Retrieval" → 勾选 → 弹窗粘贴 Step 7.4 的 API Key → 保存。

- [ ] **Step 7.7: 与 Agent 对话验证检索**

打开和该 Agent 的 chat 窗口，输入：

> 去知识库查一下 [你 PDF 里的某个关键词]

预期：Agent 调用 ragflow_retrieval 工具 → 返回带文件名 / 页码 / 相似度的引用列表 → Agent 自然语言复述给用户 + 列引用源（应能看到 Step 7.3 上传的 PDF 文件名 + 页码）。

- [ ] **Step 7.8: 验证 API Key 缺失时友好提示**

新建第二个 Agent，**不**配置 API Key 直接勾选 RAGFlow Retrieval → 与之对话："去知识库查 X" → 预期：Agent 收到的工具返回包含 `❌ This agent has no RAGFlow API key configured`，进而引导用户配置。

- [ ] **Step 7.9: 验证零结果不报错**

回到第一个 Agent，提问一个 PDF 中肯定不存在的关键词 → 预期：返回 `Knowledge base returned no relevant results for this query.` 而非异常。

- [ ] **Step 7.10: docker 模式快速验证（可选，按部署需要做）**

如果你的部署线就是 dev 模式，可以跳过此步。如果是 docker 部署：

```bash
./stop.sh
docker compose up -d
sleep 120
docker logs clawith-backend 2>&1 | grep -i "ragflow_retrieval"
```
预期：seeder 日志显示 `Updated mcp_server_url: ragflow_retrieval`，DB 里 `mcp_server_url` 应已变为 `http://ragflow-cpu:9382/mcp`。然后用 Step 7.5-7.7 的流程在 docker 模式重测一次。

- [ ] **Step 7.11: 把验证结果写到 commit message 备份**

把以下内容贴到任意临时文件，将来给 PR description 用：

```markdown
## RAGFlow MCP 集成 — 验收记录

- [x] dev.sh 启动后 RAGFlow 4 进程齐备（api/task_executor/web/mcp）
- [x] DB 中 ragflow_retrieval Tool 行 type=mcp, url 与 RAGFLOW_MCP_URL 匹配
- [x] curl /mcp tools/list 返回工具清单（dataset 列表已嵌入 description）
- [x] curl /mcp tools/call 检索成功
- [x] Clawith UI 配 API Key → Agent 对话检索成功，返回引用列表
- [x] 缺 API Key 时返回友好提示，不报内部错误
- [x] 零结果场景返回友好文案
- [x] (可选) docker 模式 mcp_server_url 自动 upsert 为 ragflow-cpu:9382/mcp
```

- [ ] **Step 7.12: 关闭并清理**

```bash
cd /Users/lance/LaboFlow
./stop.sh
lsof -iTCP:9380 -iTCP:9382 -iTCP:8880 -sTCP:LISTEN
```
预期：第二条无输出。

---

## 集成测试（可选 / follow-up）

> 这部分**不在主 plan 里强制**——它需要真起 RAGFlow + 准备好 dataset + API Key。当前 7 个 task 完成后基础链路已可用。把这个作为 follow-up 任务。

如果将来要把 e2e 集成测试纳入 CI，可创建 `Clawith/backend/tests/test_ragflow_mcp_integration.py`：

```python
import os
import pytest


@pytest.mark.skipif(
    not (os.getenv("RAGFLOW_TEST_API_KEY") and os.getenv("RAGFLOW_TEST_DATASET_ID")),
    reason="Set RAGFLOW_TEST_API_KEY and RAGFLOW_TEST_DATASET_ID to run.",
)
@pytest.mark.asyncio
async def test_end_to_end_retrieval_against_real_ragflow():
    """Hit a real RAGFlow MCP server and verify formatted output."""
    from app.services.mcp_client import MCPClient
    from app.services.agent_tools import _format_ragflow_response

    url = os.getenv("RAGFLOW_MCP_URL", "http://localhost:9382/mcp")
    key = os.environ["RAGFLOW_TEST_API_KEY"]
    dataset_id = os.environ["RAGFLOW_TEST_DATASET_ID"]

    client = MCPClient(url, api_key=key)
    raw = await client.call_tool(
        "ragflow_retrieval",
        {"question": "test", "dataset_ids": [dataset_id]},
    )
    formatted = _format_ragflow_response(raw)

    assert (
        "Knowledge base" in formatted or "no relevant results" in formatted
    ), f"unexpected output: {formatted[:300]}"
```

跑：

```bash
RAGFLOW_TEST_API_KEY=<key> \
RAGFLOW_TEST_DATASET_ID=<dataset-id> \
.venv/bin/python -m pytest tests/test_ragflow_mcp_integration.py -v
```

---

## Self-Review

**Spec coverage:**

- spec Section 1（架构 / 通信链路） → Task 5 dev.sh 启动 + Task 6 docker-compose ✅
- spec Section 2（RAGFlow MCP server 启用配置） → Task 6 ✅
- spec Section 3（Tool seed） → Task 3 + Task 4（i18n） ✅
- spec Section 4（返回格式化） → Task 1 + Task 2 ✅
- spec Section 5（dev 模式启动） → Task 5 ✅
- spec Section 6（生产模式启动） → Task 6 ✅
- spec Section 7（双形态环境变量） → Task 5 (dev.sh inject + .env.example) + Task 6 (docker-compose env) ✅
- spec Section 8.1（错误兜底文案） → Task 2 (api_key 预检查) + Task 1 (空结果 / 解析失败 fallback) ✅
- spec Section 8.2（API Key 预检查） → Task 2 Step 2.4 ✅
- spec Section 8.3（mcp_client timeout） → **撤销**（plan 顶部 Spec Deviations 1，已说明默认 timeout 已足够）✅
- spec Section 8.5（单元测试） → Task 1 / 2 / 3 都有 TDD ✅
- spec Section 8.7（手动冒烟脚本） → Task 5 Step 5.13 + Task 7 Step 7.5 ✅
- spec Section 8.8（验收 checklist） → Task 7 Step 7.1-7.11 ✅
- spec Section 9（实施顺序 + 范围内/外） → 实施顺序见各 Task 编号；范围外项均未出现在 plan 中 ✅

**Placeholder scan:**

- 无 "TBD/TODO/适当处理" 占位
- 每个 step 都给出可执行命令、可粘贴代码、明确预期
- Step 5.11 提到"如果辅助函数名不是 ok/warn 按实际名字替换"——这是有意保留的小灵活性，不是 placeholder（setup-all.sh 现有命名风格我没全看完）
- Step 6.3 说"如果 service 已有 environment 段"——这是条件分支（YAML 现状两种可能都合理），不是 placeholder

**Type / 命名 consistency:**

- `_format_ragflow_response`：Task 1 定义、Task 2 调用 ✅
- `mcp_server_name == "RAGFlow"`：Task 2 dispatcher 判断 + Task 3 seed ✅
- `mcp_tool_name == "ragflow_retrieval"`：Task 3 seed + Task 7 用户调用名一致 ✅
- `RAGFLOW_MCP_URL` / `RAGFLOW_MCP_PORT` env：Task 3 seeder 读 + Task 5 dev.sh 注入 + Task 6 docker-compose 覆盖一致 ✅
- `--mode=host`：Task 5 dev.sh + Task 6 docker-compose 一致 ✅
- 测试文件路径 `Clawith/backend/tests/test_ragflow_mcp.py`：Task 1/2/3 引用一致 ✅

**Scope check:**

- 单 plan 单 PR 可执行
- 改动覆盖 backend (3 文件) + frontend i18n (2 文件) + 4 个脚本 + 3 个 compose/env 文件 + 1 个新测试文件 = 共 13 个文件，但都聚焦同一 feature
- 无重复或矛盾任务

---

## Execution Handoff

Plan 已写完并保存。**Two execution options:**

**1. Subagent-Driven（推荐）** — 每个 Task 派单独 subagent 执行 + 中间审查，迭代快。Task 1/2/3 的 TDD 单元测试 + Task 5 的 dev.sh 改动结构上独立性较好，subagent 模式能快速并发推进。

**2. Inline Execution** — 当前会话顺序执行，每完成一 Phase 暂停让你审查。

**选哪个？**
