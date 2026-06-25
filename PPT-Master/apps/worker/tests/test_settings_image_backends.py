"""Tests for image-backends settings API."""
import pytest
from httpx import AsyncClient, ASGITransport

from pptmaster.main import app


@pytest.mark.asyncio
async def test_list_available_backends_returns_registry():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client:
        # public route (no auth needed for the catalog)
        resp = await client.get("/api/settings/image-backends/available")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        names = [b["name"] for b in data]
        assert "gemini" in names
        assert "openai" in names
        # tier classification present
        for item in data:
            assert item["tier"] in ("core", "extended", "experimental")


# ---------------------------------------------------------------------------
# CRUD tests (T5) — use admin_client / non_admin_client fixtures from conftest
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_and_list_image_backend(admin_client, clean_image_backend_configs):
    payload = {
        "backend": "gemini",
        "api_key": "test-key-123",
        "model": None,
        "is_default": True,
        "display_name": "My Gemini",
    }
    create = await admin_client.put("/api/settings/image-backends", json=payload)
    assert create.status_code == 201, create.text
    created = create.json()
    assert created["backend"] == "gemini"
    assert created["is_default"] is True
    assert "api_key" not in created
    assert created["has_api_key"] is True

    lst = await admin_client.get("/api/settings/image-backends")
    assert lst.status_code == 200
    ids = [c["id"] for c in lst.json()]
    assert created["id"] in ids


@pytest.mark.asyncio
async def test_update_image_backend_keeps_key_when_omitted(admin_client, clean_image_backend_configs):
    created = (await admin_client.put("/api/settings/image-backends", json={
        "backend": "gemini", "api_key": "original-key", "is_default": False,
    })).json()
    # PATCH without api_key — original key must survive
    patch_resp = await admin_client.patch(
        f"/api/settings/image-backends/{created['id']}",
        json={"display_name": "Renamed"},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["display_name"] == "Renamed"
    # Verify key still present via DB
    from sqlalchemy import select
    from pptmaster.db.models import ImageBackendConfig
    from pptmaster.db.session import open_db_session
    async with open_db_session() as session:
        cfg = (await session.execute(
            select(ImageBackendConfig).where(ImageBackendConfig.id == created["id"])
        )).scalar_one()
        assert cfg.api_key_encrypted == b"original-key"


@pytest.mark.asyncio
async def test_set_default_clears_other_default(admin_client, clean_image_backend_configs):
    a = (await admin_client.put("/api/settings/image-backends", json={
        "backend": "gemini", "api_key": "k1", "is_default": True,
    })).json()
    b = (await admin_client.put("/api/settings/image-backends", json={
        "backend": "openai", "api_key": "k2", "is_default": True,
    })).json()
    lst = (await admin_client.get("/api/settings/image-backends")).json()
    defaults = [c for c in lst if c["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["id"] == b["id"]


@pytest.mark.asyncio
async def test_delete_image_backend(admin_client, clean_image_backend_configs):
    created = (await admin_client.put("/api/settings/image-backends", json={
        "backend": "gemini", "api_key": "k", "is_default": False,
    })).json()
    delete = await admin_client.delete(f"/api/settings/image-backends/{created['id']}")
    assert delete.status_code == 204


@pytest.mark.asyncio
async def test_non_admin_rejected(non_admin_client):
    resp = await non_admin_client.get("/api/settings/image-backends")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_concurrent_default_returns_409(admin_client, clean_image_backend_configs, monkeypatch):
    """When a concurrent writer causes a DB IntegrityError on is_default, return 409."""
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from sqlalchemy.exc import IntegrityError as SAIntegrityError
    from pptmaster.api import settings as settings_module

    real_open_db_session = settings_module.open_db_session

    @asynccontextmanager
    async def racy_session():
        async with real_open_db_session() as s:
            original_commit = s.commit

            async def raise_integrity():
                raise SAIntegrityError("simulated race", None, Exception())

            s.commit = raise_integrity
            yield s

    monkeypatch.setattr(settings_module, "open_db_session", racy_session)

    resp = await admin_client.put("/api/settings/image-backends", json={
        "backend": "openai", "api_key": "k2", "is_default": True,
    })
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "CONFLICT"


@pytest.mark.asyncio
async def test_image_backend_probe_returns_structured_result(admin_client, clean_image_backend_configs, monkeypatch):
    # Stub the subprocess so the test doesn't make real API calls
    async def fake_run_script(*args, **kwargs):
        return {"success": True, "stdout": "/tmp/probe.png"}

    monkeypatch.setattr(
        "pptmaster.agent.tools.source.run_script", fake_run_script, raising=False,
    )

    cfg = (await admin_client.put("/api/settings/image-backends", json={
        "backend": "gemini", "api_key": "fake", "is_default": False,
    })).json()

    probe = await admin_client.post(f"/api/settings/image-backends/{cfg['id']}/test")
    assert probe.status_code == 200
    body = probe.json()
    assert body["success"] is True
    assert "latency_ms" in body
