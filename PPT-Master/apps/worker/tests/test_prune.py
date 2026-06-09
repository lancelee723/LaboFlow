"""Tests for the prune CLI (D6 — hard-delete past-TTL soft-deleted projects)."""
from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest


def _make_project(
    project_id: str,
    soft_deleted_at: datetime | None,
) -> MagicMock:
    p = MagicMock()
    p.id = project_id
    p.soft_deleted_at = soft_deleted_at
    return p


# ---------------------------------------------------------------------------
# Prune with mock TTL of 0 seconds removes the row and directory
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prune_removes_row_and_dir(tmp_path: Path) -> None:
    """Prune with TTL=0 should hard-delete the project row and its directory."""
    project_dir = tmp_path / "projects" / "proj-old"
    project_dir.mkdir(parents=True)
    (project_dir / "output.pptx").write_bytes(b"pptx")

    old_project = _make_project(
        "proj-old",
        datetime(2020, 1, 1, tzinfo=timezone.utc),  # well past any TTL
    )

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    # execute() is called twice: once for select(Project), once for delete(TemplateUpload)
    select_result = MagicMock()
    select_result.scalars = MagicMock(return_value=MagicMock(all=MagicMock(return_value=[old_project])))
    delete_result = MagicMock()
    delete_result.rowcount = 0
    mock_session.execute = AsyncMock(side_effect=[select_result, delete_result])
    mock_session.delete = AsyncMock()
    mock_session.commit = AsyncMock()

    with (
        patch("pptmaster.prune.open_db_session", return_value=mock_session),
        patch("pptmaster.prune.get_settings", return_value=MagicMock(storage_root=str(tmp_path))),
        patch("pptmaster.prune.TTL", timedelta(seconds=0)),
    ):
        from pptmaster.prune import prune
        count = await prune()

    assert count == 1
    assert not project_dir.exists(), "Project directory should be removed after prune"
    mock_session.delete.assert_awaited_once_with(old_project)
    mock_session.commit.assert_awaited_once()


# ---------------------------------------------------------------------------
# Prune does NOT touch projects that aren't soft-deleted
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prune_ignores_active_projects(tmp_path: Path) -> None:
    """Prune should only operate on projects where soft_deleted_at < cutoff.
    We simulate this by having the DB return no rows (as the real query would)."""
    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    select_result = MagicMock()
    select_result.scalars = MagicMock(return_value=MagicMock(all=MagicMock(return_value=[])))
    delete_result = MagicMock()
    delete_result.rowcount = 0
    mock_session.execute = AsyncMock(side_effect=[select_result, delete_result])
    mock_session.delete = AsyncMock()
    mock_session.commit = AsyncMock()

    with (
        patch("pptmaster.prune.open_db_session", return_value=mock_session),
        patch("pptmaster.prune.get_settings", return_value=MagicMock(storage_root=str(tmp_path))),
    ):
        from pptmaster.prune import prune
        count = await prune()

    assert count == 0
    mock_session.delete.assert_not_awaited()


# ---------------------------------------------------------------------------
# Prune deletes expired TemplateUpload rows
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prune_deletes_expired_template_uploads(tmp_path: Path) -> None:
    """Prune should execute a DELETE on TemplateUpload rows past expires_at."""
    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    select_result = MagicMock()
    select_result.scalars = MagicMock(return_value=MagicMock(all=MagicMock(return_value=[])))
    delete_result = MagicMock()
    delete_result.rowcount = 3  # 3 expired template uploads cleaned up
    mock_session.execute = AsyncMock(side_effect=[select_result, delete_result])
    mock_session.delete = AsyncMock()
    mock_session.commit = AsyncMock()

    with (
        patch("pptmaster.prune.open_db_session", return_value=mock_session),
        patch("pptmaster.prune.get_settings", return_value=MagicMock(storage_root=str(tmp_path))),
    ):
        from pptmaster.prune import prune
        count = await prune()

    assert count == 0  # no projects deleted
    # The second execute call is the TemplateUpload DELETE
    assert mock_session.execute.await_count == 2
    mock_session.commit.assert_awaited_once()


# ---------------------------------------------------------------------------
# Prune continues when shutil.rmtree raises OSError (does NOT delete DB row)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prune_continues_on_rmtree_oserror(tmp_path: Path) -> None:
    """When rmtree raises OSError, prune should skip the DB delete for that
    project and continue to the next one instead of aborting the whole run."""
    old_project = _make_project(
        "proj-stuck",
        datetime(2020, 1, 1, tzinfo=timezone.utc),
    )

    mock_session = AsyncMock()
    mock_session.__aenter__ = AsyncMock(return_value=mock_session)
    mock_session.__aexit__ = AsyncMock(return_value=False)

    select_result = MagicMock()
    select_result.scalars = MagicMock(
        return_value=MagicMock(all=MagicMock(return_value=[old_project]))
    )
    delete_result = MagicMock()
    delete_result.rowcount = 0
    mock_session.execute = AsyncMock(side_effect=[select_result, delete_result])
    mock_session.delete = AsyncMock()
    mock_session.commit = AsyncMock()

    with (
        patch("pptmaster.prune.open_db_session", return_value=mock_session),
        patch("pptmaster.prune.get_settings", return_value=MagicMock(storage_root=str(tmp_path))),
        patch("pptmaster.prune.TTL", timedelta(seconds=0)),
        patch("shutil.rmtree", side_effect=OSError("Permission denied")),
        patch("pptmaster.prune.logger") as mock_logger,
    ):
        # Create the project dir so the exists() check triggers rmtree
        project_dir = tmp_path / "projects" / "proj-stuck"
        project_dir.mkdir(parents=True)

        from pptmaster.prune import prune
        count = await prune()

    # count must be 0 — DB row was NOT deleted
    assert count == 0
    mock_session.delete.assert_not_awaited()
    # A warning must have been logged with the project id
    mock_logger.warning.assert_called_once()
    warn_kwargs = mock_logger.warning.call_args
    assert warn_kwargs[0][0] == "prune_skip_project"
    assert warn_kwargs[1]["extra"]["project_id"] == "proj-stuck"
