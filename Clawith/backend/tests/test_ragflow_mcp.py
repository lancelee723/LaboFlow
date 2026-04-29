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


def test_format_ragflow_null_similarity_does_not_crash():
    from app.services.agent_tools import _format_ragflow_response
    chunk = {"content": "ok", "similarity": None, "document_keyword": "A.pdf",
             "dataset_name": "DS", "document_id": "d1", "dataset_id": "s1", "positions": []}
    out = _format_ragflow_response(json.dumps({"chunks": [chunk], "pagination": {}}))
    assert "A.pdf" in out  # must not raise


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

    # Monkeypatch async_session to yield Tool then AgentTool
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
