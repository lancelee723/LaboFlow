"""Project management API routes."""

import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel

from pptmaster.api._errors import AppError, ErrorCode
from sqlalchemy import desc, select

from pptmaster.auth.middleware import AuthContext, get_auth_context, require_creator
from pptmaster.config import get_settings
from pptmaster.db.models import Artifact, Project
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/projects", tags=["projects"])

SOURCE_ALLOWED_SUFFIXES = {".pdf", ".docx", ".xlsx", ".xlsm", ".pptx", ".md", ".txt"}
MAX_SOURCE_BYTES = 200 * 1024 * 1024  # 200MB


class CreateProjectRequest(BaseModel):
    name: str
    format: str = "ppt169"
    template_id: str | None = None
    brand_id: str | None = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    format: str
    status: str
    current_step: int
    ai_summary: str | None
    user_summary: str | None
    ai_tags: list[str] | None
    user_tags: list[str] | None
    soft_deleted_at: str | None
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class UpdateProjectRequest(BaseModel):
    name: str | None = None
    user_summary: str | None = None
    user_tags: list[str] | None = None


class SourceArtifactResponse(BaseModel):
    id: str
    kind: str  # "source" or "source_url"
    filename: str
    size_bytes: int | None
    meta: dict | None
    created_at: str


def _project_to_response(p: Project) -> ProjectResponse:
    return ProjectResponse(
        id=p.id,
        name=p.name,
        format=p.format,
        status=p.status,
        current_step=p.current_step,
        ai_summary=p.ai_summary,
        user_summary=p.user_summary,
        ai_tags=p.ai_tags,
        user_tags=p.user_tags,
        soft_deleted_at=p.soft_deleted_at.isoformat() if p.soft_deleted_at else None,
        created_at=p.created_at.isoformat() if p.created_at else "",
        updated_at=p.updated_at.isoformat() if p.updated_at else "",
    )


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status: str | None = None,
    sort: str = "updated_at",
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        query = select(Project).where(
            Project.owner_id == auth.user_id,
            Project.soft_deleted_at.is_(None),  # D3: exclude soft-deleted
        )

        if status:
            query = query.where(Project.status == status)

        if sort == "updated_at":
            query = query.order_by(desc(Project.updated_at))
        elif sort == "created_at":
            query = query.order_by(desc(Project.created_at))

        query = query.offset((page - 1) * per_page).limit(per_page)
        result = await session.execute(query)
        projects = result.scalars().all()

        return [_project_to_response(p) for p in projects]


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    request: CreateProjectRequest,
    auth: AuthContext = Depends(require_creator),
):
    project_id = str(uuid4())
    storage_root = get_settings().storage_root
    storage_path = f"{storage_root}/projects/{project_id}"

    async with open_db_session() as session:
        project = Project(
            id=project_id,
            owner_id=auth.user_id,
            name=request.name,
            format=request.format,
            template_id=request.template_id,
            brand_id=request.brand_id,
            storage_path=storage_path,
            status="draft",
            current_step=1,
        )
        session.add(project)
        await session.commit()

        return _project_to_response(project)


@router.get("/_trash", response_model=list[ProjectResponse])
async def list_trash(auth: AuthContext = Depends(get_auth_context)):
    """D5: Return soft-deleted projects for the current user (Trash tab)."""
    async with open_db_session() as session:
        projects = (await session.execute(
            select(Project)
            .where(
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.isnot(None),
            )
            .order_by(desc(Project.soft_deleted_at))
        )).scalars().all()
        return [_project_to_response(p) for p in projects]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: 404 on soft-deleted
            )
        )
        project = result.scalar_one_or_none()

        if not project:
            raise AppError(ErrorCode.PROJECT_NOT_FOUND, "Project not found", status_code=404)

        return _project_to_response(project)


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    request: UpdateProjectRequest,
    auth: AuthContext = Depends(require_creator),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: can't edit soft-deleted
            )
        )
        project = result.scalar_one_or_none()

        if not project:
            raise AppError(ErrorCode.PROJECT_NOT_FOUND, "Project not found", status_code=404)

        if request.name is not None:
            project.name = request.name
        if request.user_summary is not None:
            project.user_summary = request.user_summary
        if request.user_tags is not None:
            project.user_tags = request.user_tags

        project.updated_at = datetime.now(timezone.utc)
        await session.commit()

        return _project_to_response(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    auth: AuthContext = Depends(require_creator),
):
    """D2: Soft-delete — sets soft_deleted_at timestamp. Files stay on disk."""
    async with open_db_session() as session:
        project = (await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # already-deleted → 404
            )
        )).scalar_one_or_none()
        if not project:
            raise HTTPException(404, detail="Project not found")
        project.soft_deleted_at = datetime.now(timezone.utc)
        project.soft_deleted_by = auth.user_id
        await session.commit()
    return None


@router.post("/{project_id}/restore", status_code=200)
async def restore_project(
    project_id: str,
    auth: AuthContext = Depends(require_creator),
):
    """D4: Restore a soft-deleted project."""
    async with open_db_session() as session:
        project = (await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.isnot(None),  # must be soft-deleted
            )
        )).scalar_one_or_none()
        if not project:
            raise HTTPException(404, detail="Project not found")
        project.soft_deleted_at = None
        project.soft_deleted_by = None
        await session.commit()
    return {"restored": True}


@router.delete("/{project_id}/permanent", status_code=200)
async def permanent_delete_project(
    project_id: str,
    auth: AuthContext = Depends(require_creator),
):
    """Hard-delete a soft-deleted project — removes files from disk and DB row.

    Only works on projects that are already soft-deleted (in the Trash).
    Active projects must go through the normal DELETE → Trash flow first.
    """
    async with open_db_session() as session:
        project = (await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.isnot(None),
            )
        )).scalar_one_or_none()
        if not project:
            raise HTTPException(404, detail="Project not found")

        # Remove project directory from disk
        project_dir = Path(project.storage_path)
        if project_dir.exists():
            try:
                shutil.rmtree(project_dir)
            except OSError:
                pass  # best-effort — DB delete still proceeds

        await session.delete(project)
        await session.commit()
    return {"deleted": True, "project_id": project_id}


@router.get("/{project_id}/export.pptx")
async def download_pptx(
    project_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    from fastapi.responses import FileResponse
    import os

    storage_root = get_settings().storage_root
    pptx_path = f"{storage_root}/projects/{project_id}/exports/output.pptx"
    if not os.path.isfile(pptx_path):
        raise AppError(ErrorCode.PPTX_NOT_FOUND, "PPTX not found. Run the pipeline first.", status_code=404)

    return FileResponse(pptx_path, media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation", filename="presentation.pptx")


@router.get("/{project_id}/sources", response_model=list[SourceArtifactResponse])
async def list_sources(
    project_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """Return every source artifact attached to a project."""
    async with open_db_session() as session:
        project = (await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: exclude soft-deleted
            )
        )).scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")

        rows = (await session.execute(
            select(Artifact)
            .where(
                Artifact.project_id == project_id,
                Artifact.kind.in_(["source", "source_url"]),
            )
            .order_by(Artifact.created_at)
        )).scalars().all()

        return [
            SourceArtifactResponse(
                id=a.id,
                kind=a.kind,
                filename=a.filename,
                size_bytes=(a.meta or {}).get("size_bytes"),
                meta=a.meta,
                created_at=a.created_at.isoformat() if a.created_at else "",
            )
            for a in rows
        ]


@router.post(
    "/{project_id}/sources",
    response_model=SourceArtifactResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_source(
    project_id: str,
    request: Request,
    file: UploadFile | None = File(None),
    url: str | None = Form(None),
    auth: AuthContext = Depends(require_creator),
):
    """Attach a source: either a multipart file upload OR a JSON/form {url} body.
    File is saved to {project.storage_path}/sources/original/{filename} and
    an Artifact row is registered. URL is registered as kind='source_url'
    with the URL stored in meta.url; no fetch happens here — pipeline step_1
    handles conversion.

    Accepts:
    - multipart/form-data with `file` field (file upload)
    - multipart/form-data with `url` field (URL registration)
    - application/json body {"url": "..."} (URL registration)
    """
    # Also parse url from JSON body when content-type is application/json
    if url is None:
        ct = request.headers.get("content-type", "")
        if "application/json" in ct:
            try:
                body = await request.json()
                url = body.get("url")
            except Exception:
                pass

    if (file is None) == (url is None):
        raise AppError(ErrorCode.SOURCE_AMBIGUOUS, "Provide exactly one of: file (multipart) or url (JSON body)")

    async with open_db_session() as session:
        project = (await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: can't add source to soft-deleted
            )
        )).scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")

        artifact_id = str(uuid4())

        if file is not None:
            suffix = Path(file.filename or "").suffix.lower()
            if suffix not in SOURCE_ALLOWED_SUFFIXES:
                raise AppError(
                    ErrorCode.FILE_UNSUPPORTED_TYPE,
                    f"Unsupported file type: {suffix}. Allowed: {sorted(SOURCE_ALLOWED_SUFFIXES)}",
                )

            content = await file.read()
            if len(content) > MAX_SOURCE_BYTES:
                raise AppError(ErrorCode.FILE_TOO_LARGE, "File too large (max 200MB)",
                               params={"size_mb": len(content) // (1024 * 1024), "max_mb": 200})

            sources_dir = Path(project.storage_path) / "sources" / "original"
            sources_dir.mkdir(parents=True, exist_ok=True)
            disk_path = sources_dir / file.filename
            disk_path.write_bytes(content)

            artifact = Artifact(
                id=artifact_id,
                project_id=project_id,
                kind="source",
                filename=file.filename,
                relative_path=f"sources/original/{file.filename}",
                meta={"size_bytes": len(content), "content_type": file.content_type},
            )
        else:
            artifact = Artifact(
                id=artifact_id,
                project_id=project_id,
                kind="source_url",
                filename=url[:200],
                relative_path="",
                meta={"url": url, "status": "pending"},
            )

        session.add(artifact)
        await session.commit()

        return SourceArtifactResponse(
            id=artifact.id,
            kind=artifact.kind,
            filename=artifact.filename,
            size_bytes=(artifact.meta or {}).get("size_bytes"),
            meta=artifact.meta,
            created_at=artifact.created_at.isoformat() if artifact.created_at else "",
        )


@router.delete(
    "/{project_id}/sources/{artifact_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_source(
    project_id: str,
    artifact_id: str,
    auth: AuthContext = Depends(require_creator),
):
    """Remove a source artifact: delete file from disk (if file) + delete row."""
    async with open_db_session() as session:
        project = (await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: project must be active
            )
        )).scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")

        artifact = (await session.execute(
            select(Artifact).where(
                Artifact.id == artifact_id,
                Artifact.project_id == project_id,
                Artifact.kind.in_(["source", "source_url"]),
            )
        )).scalar_one_or_none()
        if not artifact:
            raise AppError(ErrorCode.SOURCE_NOT_FOUND, "Source not found", status_code=404)

        if artifact.kind == "source" and artifact.relative_path:
            disk_path = Path(project.storage_path) / artifact.relative_path
            if disk_path.is_file():
                disk_path.unlink()

        await session.delete(artifact)
        await session.commit()

    return None
