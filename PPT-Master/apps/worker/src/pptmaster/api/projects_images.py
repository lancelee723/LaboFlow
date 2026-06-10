"""Read-only image manifest endpoint for the Workspace panel."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import select

from pptmaster.api._errors import AppError, ErrorCode
from pptmaster.auth.middleware import AuthContext, get_auth_context
from pptmaster.config import get_settings
from pptmaster.db.models import Project
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _enrich_item(project_id: str, item: dict) -> dict:
    """Add thumbnail_url for items that have a physical file."""
    out = dict(item)
    if item.get("status") in ("Generated", "Sourced", "Existing"):
        out["thumbnail_url"] = f"/api/projects/{project_id}/images/{item['filename']}"
    return out


@router.get("/{project_id}/images/manifest")
async def get_image_manifest(
    project_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    """Return image_prompts.json + image_sources.json items, enriched with thumbnail URLs.

    Only the project owner may access this endpoint.
    """
    async with open_db_session() as session:
        project = (
            await session.execute(select(Project).where(Project.id == project_id))
        ).scalar_one_or_none()
        if not project or project.owner_id != auth.user_id:
            raise AppError(
                ErrorCode.PROJECT_NOT_FOUND,
                "Project not found",
                status_code=404,
            )

    base = Path(get_settings().storage_root) / "projects" / project_id / "images"
    manifest_path = base / "image_prompts.json"
    sources_path = base / "image_sources.json"

    items: list[dict] = []

    # AI-generated images from image_prompts.json
    if manifest_path.is_file():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            for item in data.get("items", []):
                items.append(_enrich_item(project_id, item))
        except (OSError, json.JSONDecodeError):
            pass

    # Web-sourced images from image_sources.json
    if sources_path.is_file():
        try:
            data = json.loads(sources_path.read_text(encoding="utf-8"))
            for item in data.get("items", []):
                items.append(
                    _enrich_item(
                        project_id,
                        {
                            "filename": item.get("filename"),
                            "status": "Sourced" if item.get("status") == "sourced" else "Pending",
                            "method": "web",
                            "license_tier": item.get("license_tier"),
                        },
                    )
                )
        except (OSError, json.JSONDecodeError):
            pass

    return {"items": items}
