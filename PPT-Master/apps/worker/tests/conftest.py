"""Shared pytest fixtures and environment setup for worker tests."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


def _resolve_scripts_dir() -> str | None:
    """Resolve the ppt-master scripts directory for local dev runs.

    Returns the configured path if it exists, the standard fallback if it exists,
    or None if neither can be found (tests that need it should skip).
    """
    configured = os.environ.get("PPTMASTER_SCRIPTS_DIR", "")
    if configured and Path(configured).is_dir():
        return configured

    # Fallback: resolve relative to this file for local dev runs where .env is
    # not on the pytest search path (cwd is repo root, .env is in apps/worker/).
    fallback = (
        Path(__file__).resolve().parents[4]
        / "ppt-master"
        / "skills"
        / "ppt-master"
        / "scripts"
    )
    if fallback.is_dir():
        return str(fallback)

    return None


# Set PPTMASTER_SCRIPTS_DIR early so pydantic-settings picks it up when
# get_settings() is first called during test collection or request handling.
_scripts_dir = _resolve_scripts_dir()
if _scripts_dir:
    os.environ.setdefault("PPTMASTER_SCRIPTS_DIR", _scripts_dir)


# ---------------------------------------------------------------------------
# Admin / non-admin client fixtures (reused by T5, T6, T7)
# ---------------------------------------------------------------------------


def _make_admin_token(user_id: str = "admin-user-1", is_server_admin: bool = True) -> str:
    """Mint a JWT for admin or non-admin use."""
    from pptmaster.auth.jwt import create_access_token
    return create_access_token({
        "sub": user_id,
        "email": "admin@example.com",
        "role": "admin" if is_server_admin else "creator",
        "is_server_admin": is_server_admin,
    })


def _make_middleware_session(is_server_admin: bool, user_id: str = "admin-user-1"):
    """Return an async context-manager that yields a fake session for middleware auth lookup."""
    fake_user = MagicMock()
    fake_user.is_server_admin = is_server_admin
    fake_user.external_id = user_id

    fake_result = MagicMock()
    fake_result.scalar_one_or_none.return_value = fake_user

    fake_session = AsyncMock()
    fake_session.execute = AsyncMock(return_value=fake_result)
    fake_session.commit = AsyncMock()

    @asynccontextmanager
    async def _ctx() -> AsyncGenerator:
        yield fake_session

    return _ctx


@pytest_asyncio.fixture(autouse=False)
async def reset_db_engine_for_admin_tests():
    """Dispose and reset the db engine singleton between tests.

    Required for any test that hits the real DB in a per-function event loop
    (pytest-asyncio default) — prevents asyncpg cross-loop reuse errors.
    Apply explicitly by declaring this fixture in the test signature.
    """
    import pptmaster.db.session as _db_session_module

    if _db_session_module._engine is not None:
        await _db_session_module._engine.dispose()
    _db_session_module._engine = None
    _db_session_module._factory = None
    yield
    if _db_session_module._engine is not None:
        await _db_session_module._engine.dispose()
    _db_session_module._engine = None
    _db_session_module._factory = None


_ADMIN_USER_ID = "admin-user-1"
_NONADMIN_USER_ID = "nonadmin-user-1"


async def _ensure_test_user(user_id: str, is_server_admin: bool) -> None:
    """Insert a minimal User row if it doesn't already exist.

    Needed so that routes writing to tables with created_by FK can succeed.
    Uses a fresh engine each call to avoid asyncpg cross-loop reuse issues.
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from pptmaster.config import get_settings

    engine = create_async_engine(get_settings().database_url, echo=False)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO pptmaster.users (id, email, is_server_admin) "
                    "VALUES (:id, :email, :admin) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {"id": user_id, "email": f"{user_id}@test.local", "admin": is_server_admin},
            )
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def admin_client(reset_db_engine_for_admin_tests):
    """AsyncClient with admin JWT; only middleware session is mocked (routes hit real DB).

    Depends on reset_db_engine_for_admin_tests so the engine is fresh for each test.
    """
    from pptmaster.main import app

    await _ensure_test_user(_ADMIN_USER_ID, is_server_admin=True)

    token = _make_admin_token(user_id=_ADMIN_USER_ID, is_server_admin=True)
    middleware_ctx = _make_middleware_session(is_server_admin=True, user_id=_ADMIN_USER_ID)

    with patch("pptmaster.auth.middleware.open_db_session", middleware_ctx):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            client.cookies.set("jwt", token)
            yield client


@pytest_asyncio.fixture
async def non_admin_client(reset_db_engine_for_admin_tests):
    """AsyncClient with non-admin JWT; middleware session returns is_server_admin=False.

    Depends on reset_db_engine_for_admin_tests so the engine is fresh for each test.
    """
    from pptmaster.main import app

    await _ensure_test_user(_NONADMIN_USER_ID, is_server_admin=False)

    token = _make_admin_token(user_id=_NONADMIN_USER_ID, is_server_admin=False)
    middleware_ctx = _make_middleware_session(is_server_admin=False, user_id=_NONADMIN_USER_ID)

    with patch("pptmaster.auth.middleware.open_db_session", middleware_ctx):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            client.cookies.set("jwt", token)
            yield client


@pytest_asyncio.fixture(autouse=False)
async def clean_image_backend_configs():
    """Delete all image_backend_configs rows after each test to prevent row leakage.

    Not autouse globally — attach explicitly to tests that write to that table.
    Uses a dedicated engine connection to avoid asyncpg "operation in progress" conflicts.
    """
    yield
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from pptmaster.config import get_settings

    engine = create_async_engine(get_settings().database_url, echo=False)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM pptmaster.image_backend_configs"))
    finally:
        await engine.dispose()


@pytest_asyncio.fixture(autouse=False)
async def clean_image_search_configs():
    """Delete all image_search_configs rows after each test to prevent row leakage.

    Not autouse globally — attach explicitly to tests that write to that table.
    Uses a dedicated engine connection to avoid asyncpg "operation in progress" conflicts.
    """
    yield
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from pptmaster.config import get_settings

    engine = create_async_engine(get_settings().database_url, echo=False)
    try:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM pptmaster.image_search_configs"))
    finally:
        await engine.dispose()
