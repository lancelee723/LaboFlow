"""Share link API routes - JWT-signed tokens for read-only project access."""

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.auth.middleware import AuthContext, get_auth_context, require_creator, is_public_path
from pptmaster.db.models import Project, ShareLink
from pptmaster.db.session import open_db_session

router = APIRouter(tags=["share"])


class CreateShareRequest(BaseModel):
    project_id: str
    expires_in_days: int | None = None  # None = permanent
    allowed_pages: list[int] | None = None  # None = all pages


class ShareResponse(BaseModel):
    token: str
    url: str
    expires_at: str | None
    revoked: bool


@router.post("/api/projects/{project_id}/share", response_model=ShareResponse)
async def create_share(
    project_id: str,
    request: CreateShareRequest,
    auth: AuthContext = Depends(require_creator),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: can't share soft-deleted project
            )
        )
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        token = secrets.token_urlsafe(32)
        expires_at = None
        if request.expires_in_days:
            expires_at = datetime.now(timezone.utc) + timedelta(days=request.expires_in_days)

        share = ShareLink(
            token=token,
            project_id=project_id,
            created_by=auth.user_id,
            expires_at=expires_at,
            allowed_pages=request.allowed_pages,
        )
        session.add(share)
        await session.commit()

        from pptmaster.config import get_settings
        settings = get_settings()
        url = f"{settings.public_base_url}/share/{token}"

        return ShareResponse(
            token=token,
            url=url,
            expires_at=expires_at.isoformat() if expires_at else None,
            revoked=False,
        )


@router.delete("/api/projects/{project_id}/share/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_share(
    project_id: str,
    token: str,
    auth: AuthContext = Depends(require_creator),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(ShareLink).where(
                ShareLink.token == token,
                ShareLink.project_id == project_id,
                ShareLink.revoked == False,
            )
        )
        share = result.scalar_one_or_none()
        if not share:
            raise HTTPException(status_code=404, detail="Share link not found")

        share.revoked = True
        await session.commit()

    return None


@router.get("/share/{token}")
async def access_share(token: str):
    """Public access to a shared project - no auth required."""
    async with open_db_session() as session:
        result = await session.execute(
            select(ShareLink).where(
                ShareLink.token == token,
                ShareLink.revoked == False,
            )
        )
        share = result.scalar_one_or_none()

        if not share:
            raise HTTPException(status_code=404, detail="Share link not found or revoked")

        if share.expires_at and share.expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=410, detail="Share link expired")

        # Get project data — exclude soft-deleted projects (return 404 like other not-found cases)
        result = await session.execute(
            select(Project).where(
                Project.id == share.project_id,
                Project.soft_deleted_at.is_(None),
            )
        )
        project = result.scalar_one_or_none()

        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        return {
            "project": {
                "id": project.id,
                "name": project.name,
                "status": project.status,
                "ai_summary": project.ai_summary,
                "ai_tags": project.ai_tags,
                "created_at": project.created_at.isoformat() if project.created_at else "",
            },
            "share": {
                "expires_at": share.expires_at.isoformat() if share.expires_at else None,
                "allowed_pages": share.allowed_pages,
            },
        }


@router.get("/api/projects/{project_id}/shares", response_model=list[ShareResponse])
async def list_shares(
    project_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(ShareLink).where(
                ShareLink.project_id == project_id,
                ShareLink.revoked == False,
            )
        )
        shares = result.scalars().all()

        from pptmaster.config import get_settings
        settings = get_settings()

        return [
            ShareResponse(
                token=s.token,
                url=f"{settings.public_base_url}/share/{s.token}",
                expires_at=s.expires_at.isoformat() if s.expires_at else None,
                revoked=s.revoked,
            )
            for s in shares
        ]
