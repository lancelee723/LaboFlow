"""Tests for C1 (DB is source of truth for is_server_admin) and
I1 (GET /api/settings/llm requires admin).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from pptmaster.auth.jwt import create_access_token
from pptmaster.main import app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_token(user_id: str = "user-1", is_server_admin: bool = False) -> str:
    """Mint a JWT with given is_server_admin value."""
    return create_access_token({
        "sub": user_id,
        "email": "test@example.com",
        "role": "admin" if is_server_admin else "creator",
        "is_server_admin": is_server_admin,
    })


def _make_middleware_session_patch(live_is_server_admin: bool):
    """Return a patch context manager for pptmaster.auth.middleware.open_db_session."""
    fake_user = MagicMock()
    fake_user.is_server_admin = live_is_server_admin
    fake_user.external_id = "user-1"

    fake_result = MagicMock()
    fake_result.scalar_one_or_none.return_value = fake_user

    fake_session = AsyncMock()
    fake_session.execute = AsyncMock(return_value=fake_result)
    fake_session.commit = AsyncMock()

    @asynccontextmanager
    async def _ctx() -> AsyncGenerator:
        yield fake_session

    return patch("pptmaster.auth.middleware.open_db_session", _ctx)


# ---------------------------------------------------------------------------
# C1 (unit): DB value overrides JWT claim — test get_auth_context directly
# ---------------------------------------------------------------------------


async def test_demoted_admin_loses_access_on_next_request():
    """JWT carries is_server_admin=True, DB says False → AuthContext role must be 'creator'."""
    from fastapi import Request

    token = _make_token(is_server_admin=True)  # stale JWT from before demotion

    with _make_middleware_session_patch(live_is_server_admin=False):
        from pptmaster.auth.middleware import get_auth_context

        # Build a minimal Request object with the JWT cookie
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/settings/profile",
            "headers": [(b"cookie", f"jwt={token}".encode())],
            "query_string": b"",
        }
        request = Request(scope)

        ctx = await get_auth_context(request, bearer=None)

    assert ctx.role == "creator"
    assert ctx.is_server_admin is False


async def test_promoted_user_gets_admin_role_on_next_request():
    """JWT carries is_server_admin=False, DB says True → AuthContext role must be 'admin'."""
    from fastapi import Request

    token = _make_token(is_server_admin=False)  # stale JWT from before promotion

    with _make_middleware_session_patch(live_is_server_admin=True):
        from pptmaster.auth.middleware import get_auth_context

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/settings/profile",
            "headers": [(b"cookie", f"jwt={token}".encode())],
            "query_string": b"",
        }
        request = Request(scope)

        ctx = await get_auth_context(request, bearer=None)

    assert ctx.role == "admin"
    assert ctx.is_server_admin is True


# ---------------------------------------------------------------------------
# C1 (HTTP): DB=False blocks admin-only endpoint even if JWT claims admin
# ---------------------------------------------------------------------------


async def test_db_false_blocks_admin_only_endpoint():
    """JWT claims admin, DB says not admin → require_admin endpoint returns 403."""
    token = _make_token(is_server_admin=True)  # stale JWT

    with _make_middleware_session_patch(live_is_server_admin=False):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/settings/llm",
                cookies={"jwt": token},
            )

    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# I1: GET /api/settings/llm requires admin
# ---------------------------------------------------------------------------


async def test_list_llm_configs_returns_200_for_admin():
    """Admin user (DB is_server_admin=True) can list LLM configs."""
    token = _make_token(is_server_admin=True)

    fake_user = MagicMock()
    fake_user.is_server_admin = True
    fake_user.external_id = "user-1"

    fake_result = MagicMock()
    fake_result.scalar_one_or_none.return_value = fake_user
    fake_result.scalars.return_value.all.return_value = []

    fake_session = AsyncMock()
    fake_session.execute = AsyncMock(return_value=fake_result)
    fake_session.commit = AsyncMock()

    @asynccontextmanager
    async def _ctx() -> AsyncGenerator:
        yield fake_session

    with (
        patch("pptmaster.auth.middleware.open_db_session", _ctx),
        patch("pptmaster.api.settings.open_db_session", _ctx),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/settings/llm",
                cookies={"jwt": token},
            )

    assert resp.status_code == 200
    assert resp.json() == []


async def test_list_llm_configs_returns_403_for_non_admin():
    """Non-admin user gets 403 on GET /api/settings/llm."""
    token = _make_token(is_server_admin=False)

    with _make_middleware_session_patch(live_is_server_admin=False):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/settings/llm",
                cookies={"jwt": token},
            )

    assert resp.status_code == 403


async def test_list_llm_configs_returns_403_for_jwt_admin_but_db_non_admin():
    """JWT says admin, DB says not admin → 403. Proves DB wins for route protection."""
    token = _make_token(is_server_admin=True)

    with _make_middleware_session_patch(live_is_server_admin=False):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get(
                "/api/settings/llm",
                cookies={"jwt": token},
            )

    assert resp.status_code == 403
