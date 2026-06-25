"""Tests for image-search settings API."""
import pytest


@pytest.mark.asyncio
async def test_list_image_search_empty(admin_client, clean_image_search_configs):
    resp = await admin_client.get("/api/settings/image-search")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_upsert_image_search_creates_then_updates(admin_client, clean_image_search_configs):
    # First call creates
    create = await admin_client.put("/api/settings/image-search", json={
        "provider": "pexels", "api_key": "key-1",
    })
    assert create.status_code in (200, 201)
    body = create.json()
    assert body["provider"] == "pexels"
    assert body["has_api_key"] is True

    # Second call (same provider) updates
    update = await admin_client.put("/api/settings/image-search", json={
        "provider": "pexels", "api_key": "key-2",
    })
    assert update.status_code in (200, 201)

    lst = (await admin_client.get("/api/settings/image-search")).json()
    pexels_entries = [c for c in lst if c["provider"] == "pexels"]
    assert len(pexels_entries) == 1


@pytest.mark.asyncio
async def test_delete_image_search_by_provider(admin_client, clean_image_search_configs):
    await admin_client.put("/api/settings/image-search", json={
        "provider": "pixabay", "api_key": "k",
    })
    delete = await admin_client.delete("/api/settings/image-search/pixabay")
    assert delete.status_code == 204
    lst = (await admin_client.get("/api/settings/image-search")).json()
    assert not any(c["provider"] == "pixabay" for c in lst)


@pytest.mark.asyncio
async def test_image_search_rejects_unknown_provider(admin_client, clean_image_search_configs):
    resp = await admin_client.put("/api/settings/image-search", json={
        "provider": "googleimages", "api_key": "x",
    })
    assert resp.status_code == 422 or resp.status_code == 400
