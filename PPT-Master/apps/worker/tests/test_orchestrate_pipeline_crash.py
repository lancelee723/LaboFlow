"""Tests verifying that a pipeline crash sets BOTH session.status_locked='failed'
and project.status='failed'.

This is the fix for the code-review finding on commit 4547246:
the original except Exception blocks only wrote session.status_locked but left
project.status stuck in 'generating', causing dashboard queries to miss failed
projects.

Both _run_pipeline and _run_pipeline_resume are covered.
"""

from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import MagicMock

import pytest

from pptmaster.api import orchestrate


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeProject:
    def __init__(self, project_id: str) -> None:
        self.id = project_id
        self.status = "generating"


class _FakeSession:
    def __init__(self, session_id: str, project_id: str, project: _FakeProject) -> None:
        self.id = session_id
        self.project_id = project_id
        self.is_interrupted: bool = False
        self.status_locked: str | None = None
        self.abort_reason: str | None = None
        self.ended_at: Any = None
        self._project = project


class _FakeDbResult:
    """Simulates the two-step execute().scalar_one_or_none() pattern."""

    def __init__(self, obj: Any) -> None:
        self._obj = obj

    def scalar_one_or_none(self) -> Any:
        return self._obj


class _FakeDb:
    """Tracks which objects were written so tests can assert final state."""

    def __init__(self, session_obj: _FakeSession, project_obj: _FakeProject) -> None:
        self._session = session_obj
        self._project = project_obj
        self.committed = False

    async def execute(self, stmt: Any) -> _FakeDbResult:
        # Dispatch by the model class embedded in the SELECT.
        # SQLAlchemy 2.x exposes the mapped class via column_descriptions[0]['entity'].
        try:
            entity = stmt.column_descriptions[0]["entity"]
        except (AttributeError, IndexError, KeyError):
            entity = None

        if entity is orchestrate.Session:
            return _FakeDbResult(self._session)
        if entity is orchestrate.Project:
            return _FakeDbResult(self._project)
        return _FakeDbResult(None)

    async def commit(self) -> None:
        self.committed = True

    async def __aenter__(self) -> "_FakeDb":
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass


@asynccontextmanager
async def _make_fake_db_ctx(db: _FakeDb):
    yield db


class _CrashingGraph:
    """Async context manager that raises RuntimeError inside astream_events."""

    async def astream_events(self, *args: Any, **kwargs: Any):
        raise RuntimeError("boom — simulated pipeline crash")
        # Make this an async generator (never reached):
        if False:
            yield {}

    async def aget_state(self, *args: Any, **kwargs: Any):
        class _Snapshot:
            tasks = ()

        return _Snapshot()


class _CrashingGraphCtx:
    async def __aenter__(self) -> "_CrashingGraph":
        return _CrashingGraph()

    async def __aexit__(self, *args: Any) -> None:
        pass


def _patch_crash(
    monkeypatch: pytest.MonkeyPatch,
    session_id: str = "sess-1",
    project_id: str = "proj-1",
) -> tuple[_FakeDb, _FakeProject, _FakeSession]:
    """Wire a crash scenario and return the mutable DB objects for assertions."""
    project = _FakeProject(project_id)
    session = _FakeSession(session_id, project_id, project)
    db = _FakeDb(session, project)

    monkeypatch.setattr(orchestrate, "compiled_coordinator", lambda: _CrashingGraphCtx())
    monkeypatch.setattr(orchestrate, "open_db_session", lambda: _make_fake_db_ctx(db))

    async def _noop(*args: Any, **kwargs: Any) -> None:
        pass

    monkeypatch.setattr(orchestrate.ws_manager, "broadcast_agent_error", _noop)

    return db, project, session


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_pipeline_crash_sets_both_session_and_project_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_run_pipeline: a RuntimeError must mark BOTH session and project as failed."""
    db, project, session = _patch_crash(monkeypatch)

    await orchestrate._run_pipeline(
        session_id="sess-1",
        thread_id="thread-1",
        initial_state={},  # type: ignore[arg-type]
        config={"configurable": {"thread_id": "thread-1"}},
    )

    # Session terminal state
    assert session.status_locked == "failed", (
        "session.status_locked must be 'failed' after a pipeline crash"
    )
    # Project must NOT be left stuck in 'generating'
    assert project.status == "failed", (
        "project.status must be 'failed' after a pipeline crash — "
        "without this, dashboard queries see the project as permanently generating"
    )
    assert db.committed, "DB changes must be committed"


@pytest.mark.asyncio
async def test_run_pipeline_resume_crash_sets_both_session_and_project_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_run_pipeline_resume: a RuntimeError must mark BOTH session and project as failed."""
    db, project, session = _patch_crash(monkeypatch, session_id="sess-2", project_id="proj-2")

    await orchestrate._run_pipeline_resume(
        session_id="sess-2",
        thread_id="thread-2",
        user_response={"answers": {"decision": "approve"}},
        config={"configurable": {"thread_id": "thread-2"}},
    )

    assert session.status_locked == "failed", (
        "session.status_locked must be 'failed' after a resume crash"
    )
    assert project.status == "failed", (
        "project.status must be 'failed' after a resume crash — "
        "without this, dashboard queries see the project as permanently generating"
    )
    assert db.committed, "DB changes must be committed"
