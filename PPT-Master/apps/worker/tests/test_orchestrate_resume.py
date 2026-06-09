"""Smoke tests: resume body containing page_count_mode + page_count (or
page_count_change at preflight) is forwarded to the LangGraph runner verbatim.

The ResumeRequest.response field is a plain dict so no schema change is
needed — these tests just assert end-to-end field preservation through
_run_pipeline_resume -> Command(resume=...).
"""

from contextlib import asynccontextmanager

import pytest
from langgraph.types import Command

from pptmaster.api import orchestrate


# ---------------------------------------------------------------------------
# Shared fakes
# ---------------------------------------------------------------------------


class FakeEventGraph:
    """Minimal stand-in for a compiled LangGraph graph."""

    def __init__(self) -> None:
        self.inputs: list = []

    async def astream_events(self, graph_input, config=None, version=None):
        self.inputs.append(graph_input)
        # Empty async generator — no events to stream.
        if False:
            yield {}

    async def aget_state(self, *args, **kwargs):
        class _Snapshot:
            tasks = ()

        return _Snapshot()


class FakeGraphContextManager:
    def __init__(self, graph: FakeEventGraph) -> None:
        self.graph = graph

    async def __aenter__(self) -> FakeEventGraph:
        return self.graph

    async def __aexit__(self, *args) -> None:
        pass


class FakeDbSession:
    async def execute(self, *args, **kwargs):
        class _Result:
            def scalar_one_or_none(self):
                return None

        return _Result()

    async def commit(self) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> None:
        pass


@asynccontextmanager
async def fake_open_db_session():
    yield FakeDbSession()


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _patch_pipeline(monkeypatch: pytest.MonkeyPatch) -> FakeEventGraph:
    """Patch coordinator, WS manager, and DB so _run_pipeline_resume can run
    without real infrastructure. Returns the fake graph for assertions."""
    fake_graph = FakeEventGraph()

    monkeypatch.setattr(orchestrate, "compiled_coordinator", lambda: FakeGraphContextManager(fake_graph))
    monkeypatch.setattr(orchestrate, "open_db_session", fake_open_db_session)

    async def _noop(*args, **kwargs):
        pass

    monkeypatch.setattr(orchestrate.ws_manager, "broadcast_agent_message", _noop)

    return fake_graph


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_forwards_page_count_mode_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    """page_count_mode='explicit' + page_count=15 must reach Command(resume=...)."""
    fake_graph = _patch_pipeline(monkeypatch)

    user_response = {
        "answers": {"decision": "approve", "page_count_mode": "explicit", "page_count": 15},
        "answer": "15",
    }

    await orchestrate._run_pipeline_resume(
        session_id="sess-1",
        thread_id="thread-1",
        user_response=user_response,
        config={"configurable": {"thread_id": "thread-1"}},
    )

    assert len(fake_graph.inputs) == 1
    cmd: Command = fake_graph.inputs[0]
    assert isinstance(cmd, Command)
    forwarded = cmd.resume
    assert forwarded["answers"]["page_count_mode"] == "explicit"
    assert forwarded["answers"]["page_count"] == 15


@pytest.mark.asyncio
async def test_resume_forwards_page_count_mode_ai_decide(monkeypatch: pytest.MonkeyPatch) -> None:
    """page_count_mode='ai_decide' must reach Command(resume=...)."""
    fake_graph = _patch_pipeline(monkeypatch)

    user_response = {
        "answers": {"decision": "approve", "page_count_mode": "ai_decide"},
    }

    await orchestrate._run_pipeline_resume(
        session_id="sess-1",
        thread_id="thread-1",
        user_response=user_response,
        config={"configurable": {"thread_id": "thread-1"}},
    )

    cmd: Command = fake_graph.inputs[0]
    assert isinstance(cmd, Command)
    assert cmd.resume["answers"]["page_count_mode"] == "ai_decide"


@pytest.mark.asyncio
async def test_resume_forwards_page_count_change_at_preflight(monkeypatch: pytest.MonkeyPatch) -> None:
    """Top-level page_count_change field must reach Command(resume=...)."""
    fake_graph = _patch_pipeline(monkeypatch)

    user_response = {
        "answers": {"decision": "re_finalize"},
        "page_count_change": 18,
    }

    await orchestrate._run_pipeline_resume(
        session_id="sess-1",
        thread_id="thread-1",
        user_response=user_response,
        config={"configurable": {"thread_id": "thread-1"}},
    )

    cmd: Command = fake_graph.inputs[0]
    assert isinstance(cmd, Command)
    assert cmd.resume["page_count_change"] == 18
    assert cmd.resume["answers"]["decision"] == "re_finalize"


@pytest.mark.asyncio
async def test_resume_schema_accepts_extra_keys() -> None:
    """ResumeRequest must not strip unknown keys from the response dict."""
    from pptmaster.api.orchestrate import ResumeRequest

    req = ResumeRequest(
        session_id="sess-x",
        response={
            "answers": {"decision": "approve", "page_count_mode": "explicit", "page_count": 20},
            "page_count_change": 20,
            "some_future_field": "value",
        },
    )
    assert req.response["answers"]["page_count_mode"] == "explicit"
    assert req.response["answers"]["page_count"] == 20
    assert req.response["page_count_change"] == 20
    assert req.response["some_future_field"] == "value"
