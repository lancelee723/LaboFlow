"""Tests for share public-view behaviour with soft-deleted projects."""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_share(project_id: str = "proj-1") -> MagicMock:
    s = MagicMock()
    s.token = "tok-abc"
    s.project_id = project_id
    s.revoked = False
    s.expires_at = None
    s.allowed_pages = None
    return s


def _make_project(
    project_id: str = "proj-1",
    soft_deleted_at: datetime | None = None,
) -> MagicMock:
    p = MagicMock()
    p.id = project_id
    p.name = "Test Project"
    p.status = "done"
    p.ai_summary = None
    p.ai_tags = None
    p.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    p.soft_deleted_at = soft_deleted_at
    return p


# ---------------------------------------------------------------------------
# Public share view for a soft-deleted project returns 404
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_access_share_soft_deleted_project_returns_404() -> None:
    """GET /share/{token} for a soft-deleted project should return 404."""
    from fastapi import HTTPException
    from pptmaster.api.share import access_share

    share = _make_share()
    # DB returns None because the WHERE clause filters soft_deleted_at IS NULL
    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    share_result = MagicMock()
    share_result.scalar_one_or_none = MagicMock(return_value=share)
    # Project query returns None (soft-deleted project excluded by WHERE clause)
    project_result = MagicMock()
    project_result.scalar_one_or_none = MagicMock(return_value=None)

    mock_session.execute = AsyncMock(side_effect=[share_result, project_result])

    with patch("pptmaster.api.share.open_db_session", return_value=mock_session):
        with pytest.raises(HTTPException) as exc_info:
            await access_share("tok-abc")

    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# Public share view for an active project returns project data
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_access_share_active_project_returns_data() -> None:
    """GET /share/{token} for an active (non-deleted) project should return data."""
    from pptmaster.api.share import access_share

    share = _make_share()
    project = _make_project()

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    share_result = MagicMock()
    share_result.scalar_one_or_none = MagicMock(return_value=share)
    project_result = MagicMock()
    project_result.scalar_one_or_none = MagicMock(return_value=project)

    mock_session.execute = AsyncMock(side_effect=[share_result, project_result])

    with patch("pptmaster.api.share.open_db_session", return_value=mock_session):
        result = await access_share("tok-abc")

    assert result["project"]["id"] == "proj-1"
    assert result["project"]["name"] == "Test Project"
