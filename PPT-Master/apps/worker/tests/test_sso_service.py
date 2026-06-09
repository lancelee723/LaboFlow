"""Unit tests for SSO token validation and user mirror."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt
from sqlalchemy import select

from pptmaster.auth.sso_service import (
    validate_sso_token,
    get_or_create_user_by_sso,
)
from pptmaster.config import get_settings
from pptmaster.db.models import User


def _mint(claims: dict, secret: str | None = None) -> str:
    s = get_settings()
    return jwt.encode(claims, secret or s.jwt_secret_key, algorithm=s.jwt_algorithm)


def test_validate_sso_token_accepts_valid_clawith_token() -> None:
    s = get_settings()
    token = _mint({
        "sub": "user-123",
        "email": "alice@example.com",
        "role": "user",
        "aud": s.pptmaster_sso_audience,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    })
    claims = validate_sso_token(token)
    assert claims is not None
    assert claims["sub"] == "user-123"
    assert claims["email"] == "alice@example.com"
    assert claims["role"] == "user"


def test_validate_sso_token_rejects_wrong_audience() -> None:
    token = _mint({
        "sub": "user-123",
        "email": "alice@example.com",
        "role": "user",
        "aud": "weknora",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    })
    assert validate_sso_token(token) is None


def test_validate_sso_token_rejects_expired_token() -> None:
    s = get_settings()
    token = _mint({
        "sub": "user-123",
        "email": "alice@example.com",
        "role": "user",
        "aud": s.pptmaster_sso_audience,
        "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
    })
    assert validate_sso_token(token) is None


def test_validate_sso_token_rejects_wrong_secret() -> None:
    s = get_settings()
    token = _mint(
        {
            "sub": "user-123",
            "email": "alice@example.com",
            "role": "user",
            "aud": s.pptmaster_sso_audience,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        secret="someone-elses-secret-key-32-chars-min",
    )
    assert validate_sso_token(token) is None


def test_validate_sso_token_rejects_missing_audience_claim() -> None:
    s = get_settings()
    token = _mint({
        "sub": "user-123",
        "email": "alice@example.com",
        "role": "user",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    })
    assert validate_sso_token(token) is None


@pytest.mark.asyncio
async def test_get_or_create_user_creates_new_when_missing(db_session) -> None:
    user = await get_or_create_user_by_sso(
        db_session,
        clawith_id="new-clawith-id",
        email="newbie@example.com",
        role="user",
    )
    assert user.external_id == "new-clawith-id"
    assert user.email == "newbie@example.com"
    assert user.is_server_admin is False


@pytest.mark.asyncio
async def test_get_or_create_user_maps_admin_role(db_session) -> None:
    user = await get_or_create_user_by_sso(
        db_session,
        clawith_id="admin-clawith-id",
        email="boss@example.com",
        role="admin",
    )
    assert user.is_server_admin is True


@pytest.mark.asyncio
async def test_get_or_create_user_maps_platform_admin_role(db_session) -> None:
    user = await get_or_create_user_by_sso(
        db_session,
        clawith_id="platform-admin-id",
        email="root@example.com",
        role="platform_admin",
    )
    assert user.is_server_admin is True


@pytest.mark.asyncio
async def test_get_or_create_user_finds_by_external_id(db_session) -> None:
    db_session.add(User(
        id="existing-id",
        email="alice@example.com",
        external_id="clawith-existing",
        is_server_admin=False,
    ))
    await db_session.commit()

    user = await get_or_create_user_by_sso(
        db_session,
        clawith_id="clawith-existing",
        email="alice@example.com",
        role="user",
    )
    assert user.id == "existing-id"


@pytest.mark.asyncio
async def test_get_or_create_user_links_by_email_when_external_id_unseen(db_session) -> None:
    db_session.add(User(
        id="legacy-id",
        email="legacy@example.com",
        external_id=None,
        is_server_admin=False,
    ))
    await db_session.commit()

    user = await get_or_create_user_by_sso(
        db_session,
        clawith_id="clawith-link",
        email="legacy@example.com",
        role="user",
    )
    assert user.id == "legacy-id"
    assert user.external_id == "clawith-link"


@pytest.mark.asyncio
async def test_get_or_create_user_re_syncs_is_server_admin_on_every_call(db_session) -> None:
    db_session.add(User(
        id="promoted-id",
        email="someone@example.com",
        external_id="clawith-someone",
        is_server_admin=True,
    ))
    await db_session.commit()

    user = await get_or_create_user_by_sso(
        db_session,
        clawith_id="clawith-someone",
        email="someone@example.com",
        role="user",
    )
    assert user.is_server_admin is False
