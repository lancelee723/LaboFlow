"""Artifact workspace API routes and filesystem helpers."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.auth.middleware import AuthContext, get_auth_context
from pptmaster.db.models import Project
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/projects", tags=["artifacts"])

ArtifactContentType = Literal["text", "svg", "image", "download"]

ROOT_TEXT_ARTIFACTS: tuple[tuple[str, str, str], ...] = (
    ("outline.json", "outline", "Outline"),
    ("design_spec.md", "design_spec", "Design Spec"),
    ("spec_lock.md", "spec_lock", "Spec Lock"),
)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


class ArtifactEntry(BaseModel):
    path: str
    kind: str
    label: str
    content_type: ArtifactContentType
    size: int
    updated_at: str
    url: str


class ArtifactContentResponse(BaseModel):
    path: str
    kind: str
    content_type: ArtifactContentType
    text: str


def resolve_artifact_path(project_root: Path, relative_path: str) -> Path:
    root_path = project_root.resolve(strict=False)
    candidate = (project_root / relative_path).resolve(strict=False)

    try:
        candidate.relative_to(root_path)
    except ValueError as exc:
        raise ValueError("Artifact path escapes project storage") from exc

    return candidate


def collect_project_artifacts(project_root: Path) -> list[dict[str, str | int]]:
    if not project_root.exists() or not project_root.is_dir():
        return []

    artifacts: list[dict[str, str | int]] = []

    for relative_path, kind, label in ROOT_TEXT_ARTIFACTS:
        artifact_path = project_root / relative_path
        if artifact_path.is_file():
            artifacts.append(_build_artifact_record(project_root, artifact_path, kind, label, "text"))

    svg_dir = project_root / "svg_output"
    if svg_dir.is_dir():
        for artifact_path in sorted(svg_dir.glob("*.svg")):
            artifacts.append(
                _build_artifact_record(
                    project_root,
                    artifact_path,
                    "svg",
                    artifact_path.stem.replace("_", " ").title(),
                    "svg",
                )
            )

    image_dir = project_root / "images"
    if image_dir.is_dir():
        for artifact_path in sorted(image_dir.iterdir()):
            if artifact_path.is_file() and artifact_path.suffix.lower() in IMAGE_SUFFIXES:
                artifacts.append(
                    _build_artifact_record(project_root, artifact_path, "image", artifact_path.name, "image")
                )

    export_dir = project_root / "exports"
    if export_dir.is_dir():
        for artifact_path in sorted(export_dir.iterdir()):
            if artifact_path.is_file():
                artifacts.append(
                    _build_artifact_record(project_root, artifact_path, "export", artifact_path.name, "download")
                )

    return artifacts


def _build_artifact_record(
    project_root: Path,
    artifact_path: Path,
    kind: str,
    label: str,
    content_type: ArtifactContentType,
) -> dict[str, str | int]:
    stat = artifact_path.stat()
    updated_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()

    return {
        "path": artifact_path.relative_to(project_root).as_posix(),
        "kind": kind,
        "label": label,
        "content_type": content_type,
        "size": stat.st_size,
        "updated_at": updated_at,
    }


async def _get_project(project_id: str, auth: AuthContext) -> Project:
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: exclude soft-deleted
            )
        )
        project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return project


def _decorate_artifact_entry(project_id: str, artifact: dict[str, str | int]) -> ArtifactEntry:
    path = artifact["path"]
    if not isinstance(path, str):
        raise ValueError("Artifact path must be a string")

    # Append updated_at as a cache-buster so browsers refetch when the file
    # changes (e.g. after annotation submit regenerates the SVG).
    updated_at_str = str(artifact["updated_at"])
    cache_bust = updated_at_str.replace(":", "").replace("-", "").replace(".", "")
    return ArtifactEntry(
        path=path,
        kind=str(artifact["kind"]),
        label=str(artifact["label"]),
        content_type=artifact["content_type"],
        size=int(artifact["size"]),
        updated_at=updated_at_str,
        url=f"/api/projects/{project_id}/artifacts/file?path={path}&t={cache_bust}",
    )


@router.get("/{project_id}/artifacts", response_model=list[ArtifactEntry])
async def list_project_artifacts(
    project_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    project = await _get_project(project_id, auth)
    project_root = Path(project.storage_path)
    artifacts = collect_project_artifacts(project_root)

    return [_decorate_artifact_entry(project_id, artifact) for artifact in artifacts]


@router.get("/{project_id}/artifacts/content", response_model=ArtifactContentResponse)
async def get_artifact_content(
    project_id: str,
    path: str = Query(..., min_length=1),
    auth: AuthContext = Depends(get_auth_context),
):
    project = await _get_project(project_id, auth)
    artifact_path = resolve_artifact_path(Path(project.storage_path), path)

    if not artifact_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")

    if artifact_path.suffix.lower() == ".svg":
        content_type: ArtifactContentType = "svg"
    elif artifact_path.suffix.lower() in {".md", ".json", ".txt"}:
        content_type = "text"
    else:
        raise HTTPException(status_code=400, detail="Artifact is not a text-viewable file")

    text = artifact_path.read_text(encoding="utf-8")
    kind = next((artifact["kind"] for artifact in collect_project_artifacts(Path(project.storage_path)) if artifact["path"] == path), "text")

    return ArtifactContentResponse(
        path=path,
        kind=str(kind),
        content_type=content_type,
        text=text,
    )


@router.get("/{project_id}/artifacts/file")
async def download_artifact_file(
    project_id: str,
    path: str = Query(..., min_length=1),
    auth: AuthContext = Depends(get_auth_context),
):
    project = await _get_project(project_id, auth)
    artifact_path = resolve_artifact_path(Path(project.storage_path), path)

    if not artifact_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")

    return FileResponse(artifact_path, filename=artifact_path.name)