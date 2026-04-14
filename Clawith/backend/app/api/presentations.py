import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.database import get_db
from app.models.presentation import Presentation, PresentationVersion
from app.models.user import User
from app.schemas.schemas import (
    PresentationCreate,
    PresentationOut,
    PresentationUpdate,
    PresentationVersionCreate,
    PresentationVersionOut,
    PresentationVersionUpdate,
)

router = APIRouter(prefix="/ppt/presentations", tags=["ppt"])


@router.get("")
async def list_presentations(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation)
        .where(
            Presentation.creator_id == current_user.id,
            Presentation.is_deleted == False,
        )
        .order_by(Presentation.updated_at.desc())
    )
    presentations = result.scalars().all()
    return {
        "code": 200,
        "data": {
            "presentations": [
                PresentationOut.model_validate(p).model_dump(mode="json")
                for p in presentations
            ],
        },
    }


@router.get("/{presentation_id}")
async def get_presentation(
    presentation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.is_deleted == False,
        )
    )
    presentation = result.scalar_one_or_none()
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    if presentation.creator_id != current_user.id and not presentation.is_public:
        raise HTTPException(status_code=403, detail="Access denied")

    return {
        "code": 200,
        "data": {
            "presentation": PresentationOut.model_validate(presentation).model_dump(mode="json"),
        },
    }


@router.post("")
async def create_presentation(
    data: PresentationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    content_size = 0
    if data.content:
        content_size = len(json.dumps(data.content))

    presentation = Presentation(
        title=data.title,
        description=data.description,
        content=data.content,
        thumbnail=data.thumbnail,
        is_public=data.is_public,
        creator_id=current_user.id,
        tenant_id=current_user.tenant_id,
    )
    db.add(presentation)
    await db.flush()
    await db.refresh(presentation)

    if data.content:
        version = PresentationVersion(
            presentation_id=presentation.id,
            content=data.content,
            title=data.title,
            description=data.description or "",
            is_auto_save=False,
            author=current_user.display_name,
            size=content_size,
        )
        db.add(version)

    return {
        "code": 201,
        "data": {
            "presentation": PresentationOut.model_validate(presentation).model_dump(mode="json"),
        },
    }


@router.put("/{presentation_id}")
async def update_presentation(
    presentation_id: uuid.UUID,
    data: PresentationUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.is_deleted == False,
        )
    )
    presentation = result.scalar_one_or_none()
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    if presentation.creator_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(presentation, key, value)

    if data.content is not None:
        content_size = len(json.dumps(data.content))
        version = PresentationVersion(
            presentation_id=presentation.id,
            content=data.content,
            title=data.title or presentation.title,
            description=data.description or presentation.description or "",
            is_auto_save=True,
            author=current_user.display_name,
            size=content_size,
        )
        db.add(version)

    await db.flush()
    await db.refresh(presentation)

    return {
        "code": 200,
        "data": {
            "presentation": PresentationOut.model_validate(presentation).model_dump(mode="json"),
        },
    }


@router.delete("/{presentation_id}")
async def delete_presentation(
    presentation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.is_deleted == False,
        )
    )
    presentation = result.scalar_one_or_none()
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    if presentation.creator_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    presentation.is_deleted = True

    return {"code": 200, "data": {"message": "Presentation deleted"}}


@router.post("/{presentation_id}/duplicate")
async def duplicate_presentation(
    presentation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.is_deleted == False,
        )
    )
    original = result.scalar_one_or_none()
    if not original:
        raise HTTPException(status_code=404, detail="Presentation not found")

    if original.creator_id != current_user.id and not original.is_public:
        raise HTTPException(status_code=403, detail="Access denied")

    new_presentation = Presentation(
        title=f"{original.title} (副本)",
        description=original.description,
        content=original.content,
        thumbnail=original.thumbnail,
        is_public=False,
        creator_id=current_user.id,
        tenant_id=current_user.tenant_id,
        page_settings=original.page_settings,
    )
    db.add(new_presentation)
    await db.flush()
    await db.refresh(new_presentation)

    return {
        "code": 201,
        "data": {
            "presentation": PresentationOut.model_validate(new_presentation).model_dump(mode="json"),
        },
    }


# ── Version endpoints ──────────────────────────────────────────────


@router.get("/{presentation_id}/versions")
async def list_versions(
    presentation_id: uuid.UUID,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.is_deleted == False,
        )
    )
    presentation = result.scalar_one_or_none()
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    if presentation.creator_id != current_user.id and not presentation.is_public:
        raise HTTPException(status_code=403, detail="Access denied")

    count_result = await db.execute(
        select(func.count()).where(PresentationVersion.presentation_id == presentation_id)
    )
    total = count_result.scalar() or 0

    offset = (page - 1) * limit
    result = await db.execute(
        select(PresentationVersion)
        .where(PresentationVersion.presentation_id == presentation_id)
        .order_by(PresentationVersion.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    versions = result.scalars().all()

    return {
        "code": 200,
        "data": {
            "versions": [
                PresentationVersionOut.model_validate(v).model_dump(mode="json")
                for v in versions
            ],
            "total": total,
            "page": page,
            "limit": limit,
        },
    }


@router.post("/{presentation_id}/versions")
async def create_version(
    presentation_id: uuid.UUID,
    data: PresentationVersionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Presentation).where(
            Presentation.id == presentation_id,
            Presentation.is_deleted == False,
        )
    )
    presentation = result.scalar_one_or_none()
    if not presentation:
        raise HTTPException(status_code=404, detail="Presentation not found")

    if presentation.creator_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    content_size = 0
    if data.content:
        content_size = len(json.dumps(data.content))

    version = PresentationVersion(
        presentation_id=presentation_id,
        content=data.content,
        title=data.title or presentation.title,
        description=data.description or "",
        is_auto_save=data.is_auto_save,
        author=data.author or current_user.display_name,
        size=content_size,
    )
    db.add(version)
    await db.flush()
    await db.refresh(version)

    return {
        "code": 201,
        "data": {
            "version": PresentationVersionOut.model_validate(version).model_dump(mode="json"),
        },
    }


@router.get("/{presentation_id}/versions/{version_id}")
async def get_version(
    presentation_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PresentationVersion).where(
            PresentationVersion.id == version_id,
            PresentationVersion.presentation_id == presentation_id,
        )
    )
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    return {
        "code": 200,
        "data": {
            "version": PresentationVersionOut.model_validate(version).model_dump(mode="json"),
        },
    }


@router.put("/{presentation_id}/versions/{version_id}")
async def update_version(
    presentation_id: uuid.UUID,
    version_id: uuid.UUID,
    data: PresentationVersionUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PresentationVersion).where(
            PresentationVersion.id == version_id,
            PresentationVersion.presentation_id == presentation_id,
        )
    )
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(version, key, value)

    await db.flush()
    await db.refresh(version)

    return {
        "code": 200,
        "data": {
            "version": PresentationVersionOut.model_validate(version).model_dump(mode="json"),
        },
    }


@router.delete("/{presentation_id}/versions/{version_id}")
async def delete_version(
    presentation_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(PresentationVersion).where(
            PresentationVersion.id == version_id,
            PresentationVersion.presentation_id == presentation_id,
        )
    )
    version = result.scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    await db.delete(version)

    return {"code": 200, "data": {"message": "Version deleted"}}
