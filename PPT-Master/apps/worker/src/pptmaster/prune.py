"""Prune CLI — hard-deletes soft-deleted projects past TTL + expired template uploads."""
import asyncio
import logging
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.engine import CursorResult

from pptmaster.config import get_settings
from pptmaster.db.models import Project, TemplateUpload
from pptmaster.db.session import open_db_session

TTL = timedelta(days=30)
logger = logging.getLogger(__name__)


async def prune() -> int:
    """Hard-delete soft-deleted projects past TTL. Returns count deleted."""
    cutoff = datetime.now(timezone.utc) - TTL
    storage_root = Path(get_settings().storage_root)
    deleted_count = 0
    async with open_db_session() as session:
        rows = (await session.execute(
            select(Project).where(
                Project.soft_deleted_at.isnot(None),
                Project.soft_deleted_at < cutoff,
            )
        )).scalars().all()
        for project in rows:
            project_dir = storage_root / "projects" / project.id
            try:
                if project_dir.exists():
                    shutil.rmtree(project_dir)
            except OSError as e:
                logger.warning(
                    "prune_skip_project",
                    extra={"project_id": project.id, "error": str(e)},
                )
                continue  # leave DB row intact; surface to operator
            await session.delete(project)
            deleted_count += 1
        # Also clean up expired template uploads
        now = datetime.now(timezone.utc)
        tu_result: CursorResult[Any] = await session.execute(  # type: ignore[assignment]
            delete(TemplateUpload).where(TemplateUpload.expires_at < now)
        )
        await session.commit()
        logger.info(
            "prune_complete",
            extra={
                "projects_deleted": deleted_count,
                "template_uploads_deleted": tu_result.rowcount,
            },
        )
    return deleted_count


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(prune())


if __name__ == "__main__":
    main()
