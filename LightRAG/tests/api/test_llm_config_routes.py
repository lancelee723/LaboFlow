"""Route tests for the LLM config surface.

These tests mount a minimal FastAPI app with the router, provide a fake
`rag`, fake factories, and a real `auth_handler`. We do NOT spin up the
real LightRAG server or touch storage.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ["TOKEN_SECRET"] = "test-secret-for-llm-config-routes-12345"
os.environ["AUTH_ACCOUNTS"] = "admin:adminpass"
os.environ["JWT_ALGORITHM"] = "HS256"

# Pre-initialize config before any auth imports
from lightrag.api.config import initialize_config  # noqa: E402

_test_args = argparse.Namespace(
    auth_accounts="admin:adminpass",
    token_secret="test-secret-for-llm-config-routes-12345",
    jwt_algorithm="HS256",
    token_expire_hours=24,
    guest_token_expire_hours=24,
    enable_auth=True,
    workers=1,
    # Needed by utils_api.py at module level
    whitelist_paths="",
    # Needed by other routers at import time
    llm_binding="openai",
    embedding_binding="openai",
    embedding_dim=1536,
    max_async=4,
)
initialize_config(_test_args, force=True)

from lightrag.api.auth import auth_handler  # noqa: E402
from lightrag.api.llm_config_apply import FactoryBundle  # noqa: E402
from lightrag.api.routers.llm_config_routes import router as llm_config_router  # noqa: E402


class _FakeDocStatus:
    def __init__(self, counts: dict | None = None):
        self._counts = counts or {"processed": 0, "pending": 0, "failed": 0}

    async def get_status_counts(self):
        return self._counts


@dataclass
class _FakeRag:
    llm_model_func: Any = "llm-v1"
    llm_model_kwargs: Any = None
    embedding_func: Any = "embed-v1"
    rerank_model_func: Any = None
    working_dir: str = ""
    workspace: str = ""
    doc_status: Any = None

    def __post_init__(self):
        if self.doc_status is None:
            self.doc_status = _FakeDocStatus()


def _args() -> argparse.Namespace:
    ns = argparse.Namespace()
    ns.llm_binding = "openai"
    ns.llm_binding_host = "https://api.openai.com/v1"
    ns.llm_binding_api_key = "env-llm-key-abcdefghij"
    ns.llm_model = "gpt-4o-mini"
    ns.llm_timeout = 180
    ns.max_async = 4
    ns.openai_llm_temperature = 0.7
    ns.openai_llm_max_tokens = 16384
    ns.embedding_binding = "openai"
    ns.embedding_binding_host = "https://api.openai.com/v1"
    ns.embedding_binding_api_key = "env-embed-key-0123456789"
    ns.embedding_model = "text-embedding-3-small"
    ns.embedding_dim = 1536
    ns.embedding_token_limit = 8192
    ns.embedding_send_dim = False
    ns.embedding_timeout = 30
    ns.rerank_binding = "null"
    ns.rerank_binding_host = None
    ns.rerank_binding_api_key = None
    ns.rerank_model = None
    ns.working_dir = ""
    ns.workspace = ""
    return ns


@pytest.fixture
def tmp_overlay_path(tmp_path) -> Path:
    return tmp_path / "runtime_config.json"


@pytest.fixture
def app(tmp_overlay_path) -> FastAPI:
    app = FastAPI()
    app.include_router(llm_config_router)
    rag = _FakeRag(working_dir=str(tmp_overlay_path.parent))
    args = _args()
    tmp_overlay_path.parent.mkdir(parents=True, exist_ok=True)
    app.state.rag = rag
    app.state.args = args
    app.state.overlay_path = tmp_overlay_path
    app.state.llm_config_lock = asyncio.Lock()
    app.state.factories = FactoryBundle(
        make_llm_func=lambda: f"llm:{args.llm_model}",
        make_llm_kwargs=lambda: {},
        make_embedding_func=lambda: f"embed:{args.embedding_model}:{args.embedding_dim}",
        make_rerank_func=lambda: None if args.rerank_binding == "null" else f"rerank:{args.rerank_model}",
    )
    return app


@pytest.fixture
def admin_token() -> str:
    return auth_handler.create_token(username="admin", role="platform_admin")


@pytest.fixture
def user_token() -> str:
    return auth_handler.create_token(username="bob", role="user")


def test_get_llm_config_requires_auth(app):
    client = TestClient(app)
    resp = client.get("/llm-config")
    assert resp.status_code in (401, 403)


def test_get_llm_config_rejects_non_admin(app, user_token):
    client = TestClient(app)
    resp = client.get("/llm-config", headers={"Authorization": f"Bearer {user_token}"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "admin_required"


def test_get_llm_config_admin_returns_masked_keys(app, admin_token):
    client = TestClient(app)
    resp = client.get("/llm-config", headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["generation"] == 0
    assert body["llm"]["binding"] == "openai"
    assert body["llm"]["api_key_masked"].startswith("env-")
    assert "api_key" not in body["llm"]
    assert body["embedding"]["dim"] == 1536
    assert body["rerank"]["enabled"] is False
    assert "openai" in body["providers"]["llm_bindings"]
    assert "jina" in body["providers"]["embedding_bindings"]
    assert "aliyun" in body["providers"]["rerank_bindings"]
    assert body["has_indexed_data"] is False


# ─── POST /llm-config ───────────────────────────────────────────────────────


def _full_body(overrides: dict | None = None) -> dict:
    body = {
        "generation": 0,
        "force_clear": False,
        "llm": {
            "binding": "openai",
            "host": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
            "api_key": "env-••••ij",   # sentinel: same as mask_key("env-llm-key-abcdefghij")
            "max_async": 4,
            "timeout": 180,
            "temperature": 0.7,
            "max_tokens": 16384,
        },
        "embedding": {
            "binding": "openai",
            "host": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "api_key": "env-••••89",
            "dim": 1536,
            "token_limit": 8192,
            "send_dim": False,
            "timeout": 30,
        },
        "rerank": {
            "enabled": False,
            "binding": None,
            "host": None,
            "model": None,
            "api_key": "",
        },
    }
    if overrides:
        for path, value in overrides.items():
            section, field = path.split(".")
            body[section][field] = value
    return body


def test_post_requires_admin(app, user_token):
    client = TestClient(app)
    resp = client.post("/llm-config", json=_full_body(), headers={"Authorization": f"Bearer {user_token}"})
    assert resp.status_code == 403


def test_post_happy_llm_only_hot_swap(app, admin_token):
    client = TestClient(app)
    body = _full_body({"llm.model": "gpt-4o"})
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "applied"
    assert resp.json()["generation"] == 1
    # Overlay file written
    overlay = app.state.overlay_path
    assert overlay.exists()
    import json
    data = json.loads(overlay.read_text())
    assert data["llm"]["model"] == "gpt-4o"
    # rag mutated
    assert app.state.rag.llm_model_func == "llm:gpt-4o"
    # args mutated
    assert app.state.args.llm_model == "gpt-4o"
    # Sentinel preserved the real key
    assert data["llm"]["api_key"] == "env-llm-key-abcdefghij"


def test_post_stale_generation_returns_409(app, admin_token):
    # First bump generation so the client's `0` is stale
    import json
    app.state.overlay_path.write_text(json.dumps({"generation": 3, "llm": {}, "embedding": {}, "rerank": {}}))
    client = TestClient(app)
    body = _full_body({"llm.model": "gpt-4o"})  # generation stays 0
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "stale_config"
    assert resp.json()["detail"]["current_generation"] == 3


def test_post_embedding_rebuild_without_force_returns_409(app, admin_token):
    # Pretend there's indexed data.
    app.state.rag.doc_status = _FakeDocStatus({"processed": 1})

    client = TestClient(app)
    body = _full_body({"embedding.model": "text-embedding-3-large", "embedding.dim": 3072})
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["error"] == "embedding_rebuild_requires_clear"
    assert detail["has_indexed_data"] is True
    assert "will_clear" in detail


def test_post_embedding_rebuild_with_force_clears_and_writes(app, admin_token, tmp_path):
    app.state.rag.doc_status = _FakeDocStatus({"processed": 1})

    # Create a fake vdb file in the working dir so clear has something to delete.
    working = Path(app.state.rag.working_dir)
    (working / "vdb_entities.json").write_text("{}")

    client = TestClient(app)
    body = _full_body({"embedding.model": "text-embedding-3-large", "embedding.dim": 3072})
    body["force_clear"] = True
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "restart_required"
    assert payload["reason"] == "embedding_rebuild"
    assert "vdb_entities.json" in payload["deleted"]
    assert not (working / "vdb_entities.json").exists()
    # Overlay file written after successful clear
    assert app.state.overlay_path.exists()


def test_post_sentinel_keeps_existing_key(app, admin_token):
    client = TestClient(app)
    existing = app.state.args.llm_binding_api_key
    body = _full_body({"llm.model": "gpt-4o"})
    # body["llm"]["api_key"] is already the mask of `existing`
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200
    # Real key preserved in memory and on disk
    assert app.state.args.llm_binding_api_key == existing
    import json
    data = json.loads(app.state.overlay_path.read_text())
    assert data["llm"]["api_key"] == existing


def test_post_new_key_replaces_existing(app, admin_token):
    client = TestClient(app)
    body = _full_body({"llm.model": "gpt-4o", "llm.api_key": "sk-brand-new-real-one"})
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200
    assert app.state.args.llm_binding_api_key == "sk-brand-new-real-one"
