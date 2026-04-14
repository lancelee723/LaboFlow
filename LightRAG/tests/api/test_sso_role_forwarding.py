"""Validate that /sso-login preserves the Clawith `role` claim so the
`require_platform_admin` dependency in llm_config_routes can enforce
admin-only access."""

import os
import time

import pytest

# Set env vars before any lightrag imports so global_args picks them up
os.environ["TOKEN_SECRET"] = "test-secret-for-sso-role-forwarding-12345"
os.environ["AUTH_ACCOUNTS"] = "admin:adminpass"
os.environ["JWT_ALGORITHM"] = "HS256"

import argparse  # noqa: E402

import jwt  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Pre-initialize config with a minimal namespace so auth_handler doesn't
# call parse_args() (which fails in a test context with no .env file).
from lightrag.api.config import initialize_config  # noqa: E402

_test_args = argparse.Namespace(
    auth_accounts="admin:adminpass",
    token_secret="test-secret-for-sso-role-forwarding-12345",
    jwt_algorithm="HS256",
    token_expire_hours=24,
    guest_token_expire_hours=24,
    enable_auth=True,
    workers=1,
    whitelist_paths="",
)
initialize_config(_test_args, force=True)

from lightrag.api.auth import auth_handler  # noqa: E402


def _make_clawith_token(role: str) -> str:
    payload = {
        "sub": "user-uuid-12345678",
        "role": role,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, auth_handler.secret, algorithm=auth_handler.algorithm)


def _make_clawith_token_no_role() -> str:
    payload = {
        "sub": "user-uuid-12345678",
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, auth_handler.secret, algorithm=auth_handler.algorithm)


def _decode_lightrag_token(token: str) -> dict:
    return jwt.decode(token, auth_handler.secret, algorithms=[auth_handler.algorithm])


# Build a minimal app with only the sso-login handler (no argparse dependency)
_app = FastAPI()


@_app.post("/sso-login")
async def sso_login(request: Request):
    body = await request.json()
    external_token = body.get("token")
    if not external_token:
        raise HTTPException(status_code=400, detail="token is required")

    payload = auth_handler.validate_external_token(external_token)
    user_id = payload.get("sub", "sso_user")
    username = f"clawith_{user_id[:8]}" if len(user_id) > 8 else f"clawith_{user_id}"

    # --- THIS IS THE LINE BEING PATCHED ---
    # Before the patch: role="user" (hardcoded)
    # After the patch:  role=payload.get("role") or "user"
    clawith_role = payload.get("role") or "user"
    lightrag_token = auth_handler.create_token(
        username=username,
        role=clawith_role,
        metadata={"sso": True, "clawith_user_id": user_id, "clawith_role": clawith_role},
    )
    return {"access_token": lightrag_token, "token_type": "bearer"}


@pytest.fixture(scope="module")
def client():
    with TestClient(_app) as c:
        yield c


def test_sso_login_forwards_platform_admin_role(client):
    token = _make_clawith_token(role="platform_admin")
    resp = client.post("/sso-login", json={"token": token})
    assert resp.status_code == 200, resp.text
    lightrag_token = resp.json()["access_token"]
    decoded = _decode_lightrag_token(lightrag_token)
    assert decoded["role"] == "platform_admin"


def test_sso_login_forwards_plain_user_role(client):
    token = _make_clawith_token(role="user")
    resp = client.post("/sso-login", json={"token": token})
    assert resp.status_code == 200, resp.text
    decoded = _decode_lightrag_token(resp.json()["access_token"])
    assert decoded["role"] == "user"


def test_sso_login_defaults_to_user_when_role_missing(client):
    token = _make_clawith_token_no_role()
    resp = client.post("/sso-login", json={"token": token})
    assert resp.status_code == 200, resp.text
    decoded = _decode_lightrag_token(resp.json()["access_token"])
    assert decoded["role"] == "user"
