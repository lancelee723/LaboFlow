"""Storage quota helpers."""
import asyncio
from pathlib import Path


def _walk_dir_bytes(p: Path) -> int:
    """Synchronous directory walk — called via asyncio.to_thread to avoid blocking."""
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


async def calculate_user_storage_bytes(user_id: str) -> dict[str, int]:
    """Return {used_bytes, soft_deleted_bytes, quota_bytes} for the user."""
    from sqlalchemy import select

    from pptmaster.config import get_settings
    from pptmaster.db.models import Project
    from pptmaster.db.session import open_db_session

    storage_root = Path(get_settings().storage_root)
    quota_bytes = 10 * 1024 * 1024 * 1024  # 10 GB, informational only
    used = 0
    soft = 0
    async with open_db_session() as session:
        rows = (await session.execute(
            select(Project.id, Project.soft_deleted_at).where(
                Project.owner_id == user_id,
            )
        )).all()
        for row in rows:
            pid, soft_at = row.id, row.soft_deleted_at
            p = storage_root / "projects" / pid
            if not p.exists():
                continue
            size = await asyncio.to_thread(_walk_dir_bytes, p)
            if soft_at is not None:
                soft += size
            else:
                used += size
    return {"used_bytes": used, "soft_deleted_bytes": soft, "quota_bytes": quota_bytes}
