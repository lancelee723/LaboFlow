"""When _run_pipeline finishes the LangGraph stream without a pending interrupt,
it MUST broadcast a 'pipeline_completed' WS event exactly once. When the run
ends at a dynamic interrupt (gate), the event must NOT fire.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from pptmaster.api import orchestrate


class _FakeGraphCtx:
    def __init__(self, graph):
        self._graph = graph
    async def __aenter__(self):
        return self._graph
    async def __aexit__(self, *args):
        pass


class _FakeGraph:
    def __init__(self, pending_interrupt: bool):
        self._pending = pending_interrupt
    async def astream_events(self, *args, **kwargs):
        if False:  # empty generator
            yield {}
    async def aget_state(self, *args, **kwargs):
        class _Task:
            interrupts = (
                (MagicMock(value={"prompt": "x"}),) if self._pending else ()
            )
        class _Snap:
            tasks = (_Task(),)
        return _Snap()


@asynccontextmanager
async def _fake_open_db():
    class _S:
        async def execute(self, *a, **k):
            r = MagicMock(); r.scalar_one_or_none.return_value = None
            return r
        async def commit(self): pass
    yield _S()


async def test_pipeline_completed_event_fires_on_success(monkeypatch):
    monkeypatch.setattr(orchestrate, "compiled_coordinator", lambda: _FakeGraphCtx(_FakeGraph(pending_interrupt=False)))
    monkeypatch.setattr(orchestrate, "open_db_session", _fake_open_db)
    sent: list[tuple[str, str, dict]] = []
    async def fake_send_event(sid, kind, payload):
        sent.append((sid, kind, payload))
    monkeypatch.setattr(orchestrate.ws_manager, "send_event", fake_send_event)
    async def _noop(*a, **k): pass
    monkeypatch.setattr(orchestrate.ws_manager, "broadcast_agent_message", _noop)

    await orchestrate._run_pipeline(
        session_id="sess-1", thread_id="t-1",
        initial_state={"project_id": "p", "session_id": "sess-1"},
        config={"configurable": {"thread_id": "t-1"}},
    )

    kinds = [s[1] for s in sent]
    assert kinds.count("pipeline_completed") == 1, sent


async def test_pipeline_completed_event_skipped_on_interrupt(monkeypatch):
    monkeypatch.setattr(orchestrate, "compiled_coordinator", lambda: _FakeGraphCtx(_FakeGraph(pending_interrupt=True)))
    monkeypatch.setattr(orchestrate, "open_db_session", _fake_open_db)
    sent: list[tuple[str, str, dict]] = []
    async def fake_send_event(sid, kind, payload):
        sent.append((sid, kind, payload))
    monkeypatch.setattr(orchestrate.ws_manager, "send_event", fake_send_event)
    async def _noop(*a, **k): pass
    monkeypatch.setattr(orchestrate.ws_manager, "broadcast_blocking_gate", _noop)

    await orchestrate._run_pipeline(
        session_id="sess-2", thread_id="t-2",
        initial_state={"project_id": "p", "session_id": "sess-2"},
        config={"configurable": {"thread_id": "t-2"}},
    )

    kinds = [s[1] for s in sent]
    assert "pipeline_completed" not in kinds, sent


async def test_pipeline_completed_event_fires_on_resume_success(monkeypatch):
    """The same authoritative signal must fire when a resumed pipeline completes."""
    monkeypatch.setattr(orchestrate, "compiled_coordinator", lambda: _FakeGraphCtx(_FakeGraph(pending_interrupt=False)))
    monkeypatch.setattr(orchestrate, "open_db_session", _fake_open_db)
    sent: list[tuple[str, str, dict]] = []
    async def fake_send_event(sid, kind, payload):
        sent.append((sid, kind, payload))
    monkeypatch.setattr(orchestrate.ws_manager, "send_event", fake_send_event)
    async def _noop(*a, **k): pass
    monkeypatch.setattr(orchestrate.ws_manager, "broadcast_agent_message", _noop)

    await orchestrate._run_pipeline_resume(
        session_id="sess-3", thread_id="t-3",
        user_response={"answer": "ok"},
        config={"configurable": {"thread_id": "t-3"}},
    )

    kinds = [s[1] for s in sent]
    assert kinds.count("pipeline_completed") == 1, sent
