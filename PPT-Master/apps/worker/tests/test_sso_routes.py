"""Integration tests for the /sso endpoint."""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator
from unittest.mock import patch
from urllib.parse import urlparse, parse_qs

import pytest
from jose import jwt
from httpx import ASGITransport, AsyncClient

from pptmaster.auth.jwt import decode_token
from pptmaster.config import get_settings
from pptmaster.main import app


def _mint(claims: dict) -> str:
    s = get_settings()
    return jwt.encode(claims, s.jwt_secret_key, algorithm=s.jwt_algorithm)


def _make_sso_db_session(session):
    """Wrap a real db_session as an async context manager for open_db_session."""
    @asynccontextmanager
    async def _ctx() -> AsyncGenerator:
        yield session
    return _ctx


@pytest.mark.asyncio
async def test_sso_callback_missing_token_returns_400() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/sso", follow_redirects=False)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_sso_callback_invalid_token_returns_401() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/sso",
            params={"token": "not-a-real-jwt"},
            follow_redirects=False,
        )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_sso_callback_valid_token_sets_cookie_and_redirects(db_session) -> None:
    s = get_settings()
    token = _mint({
        "sub": "happy-user",
        "email": "happy@example.com",
        "role": "user",
        "aud": s.pptmaster_sso_audience,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    })

    sso_db_ctx = _make_sso_db_session(db_session)

    transport = ASGITransport(app=app)
    with patch("pptmaster.auth.sso_routes.open_db_session", sso_db_ctx):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/sso", params={"token": token}, follow_redirects=False)

    assert resp.status_code == 302
    assert resp.headers["location"] == "/projects"
    set_cookie = resp.headers.get("set-cookie", "")
    assert "jwt=" in set_cookie
    assert "HttpOnly" in set_cookie or "httponly" in set_cookie.lower()

    cookie_token = set_cookie.split("jwt=", 1)[1].split(";", 1)[0]
    claims = decode_token(cookie_token)
    assert claims is not None
    assert claims["sub"] == "happy-user"
    assert claims["is_server_admin"] is False


@pytest.mark.asyncio
async def test_sso_callback_admin_role_results_in_admin_cookie(db_session) -> None:
    s = get_settings()
    token = _mint({
        "sub": "boss-user",
        "email": "boss@example.com",
        "role": "platform_admin",
        "aud": s.pptmaster_sso_audience,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    })

    sso_db_ctx = _make_sso_db_session(db_session)

    transport = ASGITransport(app=app)
    with patch("pptmaster.auth.sso_routes.open_db_session", sso_db_ctx):
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/sso", params={"token": token}, follow_redirects=False)

    cookie_token = resp.headers["set-cookie"].split("jwt=", 1)[1].split(";", 1)[0]
    claims = decode_token(cookie_token)
    assert claims["is_server_admin"] is True
    assert claims["role"] == "admin"
