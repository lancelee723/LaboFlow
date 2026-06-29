"""Tests for the LangGraph checkpoint bootstrap refactor.

Background: per-request compiled_coordinator() used to call
checkpointer.setup() on every invocation, which races on CREATE TABLE
IF NOT EXISTS when /start (background task) and /status (sync HTTP) fire
concurrently from the front-end. The losing transaction throws
'duplicate key value violates unique constraint pg_type_typname_nsp_index'.

The fix moves setup() into a one-time bootstrap that holds a Postgres
session-level advisory lock so concurrent worker boots serialize through
it; subsequent compiled_coordinator() calls just compile the graph.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from pptmaster.agent import coordinator


@pytest.fixture(autouse=True)
def fake_settings(monkeypatch):
    fake = MagicMock()
    fake.database_url = "postgresql+asyncpg://u:p@localhost:5432/test"
    monkeypatch.setattr(coordinator, "get_settings", lambda: fake)
    return fake


def _fake_saver_ctx(checkpointer):
    @asynccontextmanager
    async def _ctx(url, **kwargs):
        yield checkpointer
    return _ctx


def _stub_graph(monkeypatch):
    """Bypass real graph construction so compiled_coordinator's setup()
    behavior can be tested in isolation."""
    fake_compiled = MagicMock()
    fake_graph = MagicMock()
    fake_graph.compile = lambda checkpointer=None: fake_compiled
    monkeypatch.setattr(
        coordinator, "create_coordinator_graph",
        lambda checkpointer=None: fake_graph,
    )


def _patch_psycopg(monkeypatch, fake_lock_conn):
    fake_psycopg = MagicMock()

    async def _connect(*args, **kwargs):
        return fake_lock_conn

    fake_psycopg.AsyncConnection.connect = _connect
    monkeypatch.setattr(coordinator, "psycopg", fake_psycopg, raising=False)


async def test_compiled_coordinator_does_not_call_setup(monkeypatch):
    """Per-request entry point must not re-run setup() — that's the race source."""
    fake_checkpointer = MagicMock()
    fake_checkpointer.setup = AsyncMock()

    monkeypatch.setattr(
        coordinator.AsyncPostgresSaver,
        "from_conn_string",
        _fake_saver_ctx(fake_checkpointer),
    )
    _stub_graph(monkeypatch)

    async with coordinator.compiled_coordinator():
        pass

    fake_checkpointer.setup.assert_not_awaited()


async def test_bootstrap_holds_advisory_lock_around_setup(monkeypatch):
    """Setup must run inside pg_advisory_lock so concurrent worker boots
    serialize through it instead of racing on CREATE TABLE."""
    events: list[tuple[str, object]] = []

    fake_lock_conn = MagicMock()

    async def _record_execute(sql, params=None):
        if "pg_advisory_lock" in sql:
            events.append(("lock", params))
        elif "pg_advisory_unlock" in sql:
            events.append(("unlock", params))
        return MagicMock()

    fake_lock_conn.execute = AsyncMock(side_effect=_record_execute)
    fake_lock_conn.close = AsyncMock()
    _patch_psycopg(monkeypatch, fake_lock_conn)

    fake_checkpointer = MagicMock()

    async def _record_setup():
        events.append(("setup", None))

    fake_checkpointer.setup = AsyncMock(side_effect=_record_setup)
    monkeypatch.setattr(
        coordinator.AsyncPostgresSaver,
        "from_conn_string",
        _fake_saver_ctx(fake_checkpointer),
    )

    await coordinator.bootstrap_checkpointer()

    assert [e[0] for e in events] == ["lock", "setup", "unlock"], events

    # Lock + unlock must use the same fixed key so different worker processes contend.
    assert events[0][1] == events[2][1]
    assert events[0][1] == (coordinator.CHECKPOINT_BOOTSTRAP_LOCK_KEY,)


async def test_bootstrap_releases_lock_when_setup_fails(monkeypatch):
    """If setup() raises, the advisory lock must still be released so the
    next worker boot doesn't block forever on a leaked session lock."""
    events: list[str] = []

    fake_lock_conn = MagicMock()

    async def _record_execute(sql, params=None):
        if "pg_advisory_lock" in sql:
            events.append("lock")
        elif "pg_advisory_unlock" in sql:
            events.append("unlock")
        return MagicMock()

    fake_lock_conn.execute = AsyncMock(side_effect=_record_execute)
    fake_lock_conn.close = AsyncMock()
    _patch_psycopg(monkeypatch, fake_lock_conn)

    fake_checkpointer = MagicMock()
    fake_checkpointer.setup = AsyncMock(side_effect=RuntimeError("boom"))
    monkeypatch.setattr(
        coordinator.AsyncPostgresSaver,
        "from_conn_string",
        _fake_saver_ctx(fake_checkpointer),
    )

    with pytest.raises(RuntimeError, match="boom"):
        await coordinator.bootstrap_checkpointer()

    assert events == ["lock", "unlock"]
    fake_lock_conn.close.assert_awaited()
