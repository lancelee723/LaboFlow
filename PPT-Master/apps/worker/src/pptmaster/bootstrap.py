"""Bootstrap script for initial setup (run by pptmaster-init container or dev.sh)."""

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import bcrypt
from sqlalchemy import select, text

from pptmaster.config import get_settings
from pptmaster.db.models import User
from pptmaster.db.session import get_async_session_factory, get_engine


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


async def bootstrap() -> None:
    settings = get_settings()

    async with get_engine().begin() as conn:
        await conn.execute(text("CREATE SCHEMA IF NOT EXISTS pptmaster"))

    async with get_async_session_factory()() as session:
        result = await session.execute(select(User).limit(1))
        if result.scalar_one_or_none() is not None:
            print("Bootstrap already done, skipping.")
            return

        if settings.deployment_mode == "standalone":
            admin = User(
                id=str(uuid4()),
                email=settings.initial_admin_email,
                name="Admin",
                password_hash=hash_password(settings.initial_admin_password),
                must_change_password=True,
                is_server_admin=True,
            )
            session.add(admin)

            print(f"Created initial admin: {settings.initial_admin_email}")

        await session.commit()
        print("Bootstrap complete.")


def _scan_skill_templates(root: Path) -> list[dict]:
    """Scan a ppt-master skill templates dir, return a list of row dicts ready
    for the templates table. Pure (no DB, no env), so it can be unit-tested.

    Discovers:
      - layouts/<id>/ for each id in layouts/layouts_index.json (need matching dir)
      - brands/<id>/ for each id in brands/brands_index.json (need matching dir)
      - decks/<id>/ for each subdir containing at least one .svg
    """
    rows: list[dict] = []

    # Layouts
    layouts_index = root / "layouts" / "layouts_index.json"
    if layouts_index.is_file():
        try:
            idx = json.loads(layouts_index.read_text())
        except json.JSONDecodeError:
            idx = {}
        for tid, meta in idx.items():
            layout_dir = root / "layouts" / tid
            if not layout_dir.is_dir():
                continue
            svgs = sorted(p.name for p in layout_dir.glob("*.svg"))
            rows.append({
                "id": str(uuid4()),
                "template_id": tid,
                "kind": "layout",
                "uploaded_by": None,
                "name": tid.replace("_", " ").title(),
                "summary": meta.get("summary", ""),
                "canvas_format": meta.get("canvas_format", "ppt169"),
                "primary_color": None,
                "page_count": meta.get("page_count", len(svgs)),
                "page_types": meta.get("page_types", []),
                "preview_paths": svgs,
                "storage_path": str(layout_dir),
                "json_meta": meta,
            })

    # Brands
    brands_index = root / "brands" / "brands_index.json"
    if brands_index.is_file():
        try:
            idx = json.loads(brands_index.read_text())
        except json.JSONDecodeError:
            idx = {}
        for tid, meta in idx.items():
            brand_dir = root / "brands" / tid
            if not brand_dir.is_dir():
                continue
            svgs = sorted(p.name for p in brand_dir.glob("*.svg"))
            rows.append({
                "id": str(uuid4()),
                "template_id": tid,
                "kind": "brand",
                "uploaded_by": None,
                "name": tid.replace("_", " ").title(),
                "summary": meta.get("summary", ""),
                "canvas_format": "brand",
                "primary_color": meta.get("primary_color"),
                "page_count": len(svgs),
                "page_types": [],
                "preview_paths": svgs,
                "storage_path": str(brand_dir),
                "json_meta": meta,
            })

    # Decks
    decks_root = root / "decks"
    if decks_root.is_dir():
        for deck_dir in sorted(p for p in decks_root.iterdir() if p.is_dir()):
            svgs = sorted(p.name for p in deck_dir.glob("*.svg"))
            if not svgs:
                continue
            rows.append({
                "id": str(uuid4()),
                "template_id": deck_dir.name,
                "kind": "deck",
                "uploaded_by": None,
                "name": deck_dir.name.replace("_", " ").title(),
                "summary": f"Built-in deck: {deck_dir.name}",
                "canvas_format": "ppt169",
                "primary_color": None,
                "page_count": len(svgs),
                "page_types": [],
                "preview_paths": svgs,
                "storage_path": str(deck_dir),
                "json_meta": {},
            })

    return rows


async def sync_builtin_templates() -> None:
    """Idempotently upsert built-in templates (uploaded_by IS NULL) from the
    ppt-master skill repo into the templates table."""
    settings = get_settings()
    if not settings.skill_templates_root:
        print("PPTMASTER_SKILL_TEMPLATES_ROOT not set, skipping built-in template sync.")
        return

    root = Path(settings.skill_templates_root)
    if not root.is_dir():
        print(f"Skill templates root not found: {root}")
        return

    from pptmaster.db.models import Template

    rows = _scan_skill_templates(root)
    if not rows:
        print("No built-in templates found.")
        return

    async with get_async_session_factory()() as session:
        for row in rows:
            existing = (await session.execute(
                select(Template).where(
                    Template.template_id == row["template_id"],
                    Template.uploaded_by.is_(None),
                )
            )).scalar_one_or_none()
            if existing:
                existing.kind = row["kind"]
                existing.name = row["name"]
                existing.summary = row["summary"]
                existing.canvas_format = row["canvas_format"]
                existing.primary_color = row["primary_color"]
                existing.page_count = row["page_count"]
                existing.page_types = row["page_types"]
                existing.preview_paths = row["preview_paths"]
                existing.storage_path = row["storage_path"]
                existing.json_meta = row["json_meta"]
            else:
                session.add(Template(**row))
        await session.commit()

    print(f"Synced {len(rows)} built-in templates.")


async def _main() -> None:
    await bootstrap()
    await sync_builtin_templates()


if __name__ == "__main__":
    asyncio.run(_main())
