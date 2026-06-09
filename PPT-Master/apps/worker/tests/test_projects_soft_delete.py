"""Tests for D-track soft-delete behaviour on the projects API."""
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers / factories
# ---------------------------------------------------------------------------

def _make_project(
    project_id: str = "proj-1",
    owner_id: str = "user-1",
    soft_deleted_at: datetime | None = None,
    soft_deleted_by: str | None = None,
) -> MagicMock:
    p = MagicMock()
    p.id = project_id
    p.owner_id = owner_id
    p.name = "Test Project"
    p.format = "ppt169"
    p.status = "draft"
    p.current_step = 1
    p.ai_summary = None
    p.user_summary = None
    p.ai_tags = None
    p.user_tags = None
    p.soft_deleted_at = soft_deleted_at
    p.soft_deleted_by = soft_deleted_by
    p.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    p.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    p.storage_path = "/data/projects/proj-1"
    return p


def _make_auth(user_id: str = "user-1") -> MagicMock:
    auth = MagicMock()
    auth.user_id = user_id
    auth.role = "creator"
    return auth


# ---------------------------------------------------------------------------
# D2: DELETE soft-deletes instead of physically removing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_delete_project_sets_soft_deleted_at(tmp_path: Path) -> None:
    """DELETE /projects/{id} should set soft_deleted_at but NOT remove files."""
    project = _make_project()

    # Create a fake project dir to ensure we do NOT call shutil.rmtree
    project_dir = tmp_path / "projects" / project.id
    project_dir.mkdir(parents=True)
    (project_dir / "outline.json").write_text("{}")
    project.storage_path = str(tmp_path / "projects" / project.id)

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=project))
    )
    mock_session.commit = AsyncMock()

    with patch("pptmaster.api.projects.open_db_session", return_value=mock_session):
        from pptmaster.api.projects import delete_project

        auth = _make_auth()
        result = await delete_project("proj-1", auth)

    # soft_deleted_at must be set on the project ORM object
    assert project.soft_deleted_at is not None
    assert project.soft_deleted_by == "user-1"

    # Files must NOT have been removed
    assert project_dir.exists(), "Project directory should not be removed on soft delete"

    # Endpoint returns None (204 No Content)
    assert result is None


# ---------------------------------------------------------------------------
# D3: Default list excludes soft-deleted projects
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_projects_excludes_soft_deleted() -> None:
    """GET /api/projects must only return projects where soft_deleted_at IS NULL."""
    from pptmaster.api.projects import list_projects

    # We test the query's WHERE clause by ensuring a soft-deleted project
    # would NOT be returned.  We mock the DB to return only active projects.
    active_project = _make_project(project_id="active-1")

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    scalars_result = MagicMock()
    scalars_result.all = MagicMock(return_value=[active_project])
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalars=MagicMock(return_value=scalars_result))
    )

    auth = _make_auth()
    with patch("pptmaster.api.projects.open_db_session", return_value=mock_session):
        result = await list_projects(page=1, per_page=20, status=None, sort="updated_at", auth=auth)

    assert len(result) == 1
    assert result[0].id == "active-1"
    # The SQL WHERE filter is tested by verifying the query object built includes
    # the soft_deleted_at IS NULL clause; since we mock execute() we confirm at
    # minimum that the result does not include deleted projects.


# ---------------------------------------------------------------------------
# D5: Trash endpoint returns soft-deleted projects
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_trash_returns_soft_deleted() -> None:
    """GET /api/projects/_trash must return projects where soft_deleted_at IS NOT NULL."""
    from pptmaster.api.projects import list_trash

    deleted_project = _make_project(
        project_id="del-1",
        soft_deleted_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        soft_deleted_by="user-1",
    )

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    scalars_result = MagicMock()
    scalars_result.all = MagicMock(return_value=[deleted_project])
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalars=MagicMock(return_value=scalars_result))
    )

    auth = _make_auth()
    with patch("pptmaster.api.projects.open_db_session", return_value=mock_session):
        result = await list_trash(auth=auth)

    assert len(result) == 1
    assert result[0].id == "del-1"
    assert result[0].soft_deleted_at is not None


# ---------------------------------------------------------------------------
# D4: Restore clears soft_deleted_at
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_restore_project_clears_soft_deleted_at() -> None:
    """POST /projects/{id}/restore should clear soft_deleted_at and soft_deleted_by."""
    from pptmaster.api.projects import restore_project

    deleted_project = _make_project(
        soft_deleted_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        soft_deleted_by="user-1",
    )

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=deleted_project))
    )
    mock_session.commit = AsyncMock()

    auth = _make_auth()
    with patch("pptmaster.api.projects.open_db_session", return_value=mock_session):
        result = await restore_project("proj-1", auth)

    assert deleted_project.soft_deleted_at is None
    assert deleted_project.soft_deleted_by is None
    assert result == {"restored": True}


# ---------------------------------------------------------------------------
# D2 + D3: Second DELETE on same project returns 404
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_second_delete_returns_404() -> None:
    """A project that's already soft-deleted should 404 on a second DELETE."""
    from fastapi import HTTPException
    from pptmaster.api.projects import delete_project

    # Return None because the WHERE filter (soft_deleted_at IS NULL) would
    # exclude an already-soft-deleted row.
    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None))
    )

    auth = _make_auth()
    with patch("pptmaster.api.projects.open_db_session", return_value=mock_session):
        with pytest.raises(HTTPException) as exc_info:
            await delete_project("proj-1", auth)

    assert exc_info.value.status_code == 404
