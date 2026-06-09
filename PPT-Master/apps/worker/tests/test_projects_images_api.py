"""Tests for GET /api/projects/{id}/images/manifest endpoint."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pptmaster.api.projects_images import get_image_manifest


# ---------------------------------------------------------------------------
# Helpers / factories
# ---------------------------------------------------------------------------


def _make_project(project_id: str = "img-proj-1", owner_id: str = "user-img-1") -> MagicMock:
    p = MagicMock()
    p.id = project_id
    p.owner_id = owner_id
    return p


def _make_session(project: MagicMock | None) -> AsyncMock:
    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=project))
    )
    return mock_session


def _make_auth(user_id: str = "user-img-1") -> MagicMock:
    auth = MagicMock()
    auth.user_id = user_id
    return auth


# ---------------------------------------------------------------------------
# T7-1: Manifest with items returns 200 and items[] with thumbnail_url
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manifest_returns_items(tmp_path: Path) -> None:
    """items[] returned with thumbnail_url for Generated status only."""
    project_id = "img-proj-1"
    owner_id = "user-img-1"

    images_dir = tmp_path / "projects" / project_id / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / "image_prompts.json").write_text(
        json.dumps(
            {
                "items": [
                    {"filename": "a.png", "status": "Generated", "prompt": "hero shot"},
                    {"filename": "b.png", "status": "Pending", "prompt": "background"},
                ]
            }
        ),
        encoding="utf-8",
    )

    project = _make_project(project_id=project_id, owner_id=owner_id)
    mock_session = _make_session(project)
    auth = _make_auth(user_id=owner_id)

    with (
        patch("pptmaster.api.projects_images.open_db_session", return_value=mock_session),
        patch(
            "pptmaster.api.projects_images.get_settings",
            return_value=MagicMock(storage_root=str(tmp_path)),
        ),
    ):
        result = await get_image_manifest(project_id=project_id, auth=auth)

    assert "items" in result
    assert len(result["items"]) == 2

    gen = next(i for i in result["items"] if i["filename"] == "a.png")
    assert "thumbnail_url" in gen
    assert gen["thumbnail_url"].endswith("/a.png")

    pending = next(i for i in result["items"] if i["filename"] == "b.png")
    assert "thumbnail_url" not in pending


# ---------------------------------------------------------------------------
# T7-2: Missing manifest file returns 200 with empty items[]
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manifest_returns_empty_when_missing(tmp_path: Path) -> None:
    """When no manifest files exist, endpoint returns {"items": []}."""
    project_id = "img-proj-empty"
    owner_id = "user-img-1"

    project = _make_project(project_id=project_id, owner_id=owner_id)
    mock_session = _make_session(project)
    auth = _make_auth(user_id=owner_id)

    with (
        patch("pptmaster.api.projects_images.open_db_session", return_value=mock_session),
        patch(
            "pptmaster.api.projects_images.get_settings",
            return_value=MagicMock(storage_root=str(tmp_path)),
        ),
    ):
        result = await get_image_manifest(project_id=project_id, auth=auth)

    assert result == {"items": []}


# ---------------------------------------------------------------------------
# T7-3: Non-owner gets 404
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manifest_rejects_non_owner(tmp_path: Path) -> None:
    """Project owned by a different user → AppError with status 404."""
    from pptmaster.api._errors import AppError

    project_id = "img-proj-other"
    owner_id = "user-img-owner"
    caller_id = "user-img-intruder"

    project = _make_project(project_id=project_id, owner_id=owner_id)
    mock_session = _make_session(project)
    auth = _make_auth(user_id=caller_id)  # different from owner

    with (
        patch("pptmaster.api.projects_images.open_db_session", return_value=mock_session),
        patch(
            "pptmaster.api.projects_images.get_settings",
            return_value=MagicMock(storage_root=str(tmp_path)),
        ),
    ):
        with pytest.raises(AppError) as exc_info:
            await get_image_manifest(project_id=project_id, auth=auth)

    assert exc_info.value.status_code in (403, 404)


# ---------------------------------------------------------------------------
# T7-4: image_sources.json items merged with method=web
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manifest_merges_image_sources(tmp_path: Path) -> None:
    """Items from image_sources.json appear in the list with method='web'."""
    project_id = "img-proj-sources"
    owner_id = "user-img-1"

    images_dir = tmp_path / "projects" / project_id / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / "image_sources.json").write_text(
        json.dumps(
            {
                "items": [
                    {"filename": "web1.jpg", "status": "sourced", "license_tier": "free"},
                ]
            }
        ),
        encoding="utf-8",
    )

    project = _make_project(project_id=project_id, owner_id=owner_id)
    mock_session = _make_session(project)
    auth = _make_auth(user_id=owner_id)

    with (
        patch("pptmaster.api.projects_images.open_db_session", return_value=mock_session),
        patch(
            "pptmaster.api.projects_images.get_settings",
            return_value=MagicMock(storage_root=str(tmp_path)),
        ),
    ):
        result = await get_image_manifest(project_id=project_id, auth=auth)

    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["filename"] == "web1.jpg"
    assert item["method"] == "web"
    assert "thumbnail_url" in item  # "Sourced" status → thumbnail
