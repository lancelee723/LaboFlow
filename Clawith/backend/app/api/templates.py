import json
import os

from fastapi import APIRouter, Depends, HTTPException, Query
from loguru import logger
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.ppt_template import PPTTemplate
from app.schemas.schemas import PPTTemplateOut

router = APIRouter(prefix="/ppt/templates", tags=["ppt"])


def _template_to_dict(t: PPTTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "category": t.category,
        "preview": t.preview,
        "width": t.width,
        "height": t.height,
        "slideCount": t.slide_count,
        "isPremium": t.is_premium,
        "source": t.source,
        "tags": t.tags or [],
    }


def _template_detail_to_dict(t: PPTTemplate) -> dict:
    d = _template_to_dict(t)
    d["data"] = t.data
    d["createdAt"] = t.created_at.isoformat() if t.created_at else None
    d["updatedAt"] = t.updated_at.isoformat() if t.updated_at else None
    return d


@router.get("")
async def list_templates(
    category: str | None = None,
    source: str | None = None,
    page: int = Query(1, ge=1),
    pageSize: int = Query(100, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    query = select(PPTTemplate)
    count_query = select(func.count()).select_from(PPTTemplate)

    if category:
        query = query.where(PPTTemplate.category == category)
        count_query = count_query.where(PPTTemplate.category == category)
    if source:
        query = query.where(PPTTemplate.source == source)
        count_query = count_query.where(PPTTemplate.source == source)

    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    offset = (page - 1) * pageSize
    query = query.order_by(PPTTemplate.created_at.desc()).offset(offset).limit(pageSize)

    result = await db.execute(query)
    templates = result.scalars().all()

    if not templates:
        await _seed_default_templates(db)
        result = await db.execute(query)
        templates = result.scalars().all()
        total_result = await db.execute(count_query)
        total = total_result.scalar() or 0

    return {
        "code": 200,
        "data": {
            "templates": [_template_to_dict(t) for t in templates],
            "total": total,
            "page": page,
            "pageSize": pageSize,
        },
    }


@router.get("/{template_id}")
async def get_template(
    template_id: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PPTTemplate).where(PPTTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()

    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    return {
        "code": 200,
        "data": {
            "template": _template_detail_to_dict(template),
        },
    }


async def _seed_default_templates(db: AsyncSession) -> None:
    try:
        existing = await db.execute(select(func.count()).select_from(PPTTemplate))
        if (existing.scalar() or 0) > 0:
            return

        template_dir = os.path.join(
            os.path.dirname(__file__), "..", "..", "..", "aippt", "tools", "templates", "json"
        )
        if not os.path.isdir(template_dir):
            logger.warning(f"[templates] Template dir not found: {template_dir}")
            _seed_builtin_templates(db)
            return

        imported = 0
        for fname in sorted(os.listdir(template_dir)):
            if not fname.endswith(".json") or fname.startswith("_"):
                continue
            fpath = os.path.join(template_dir, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                tpl = PPTTemplate(
                    id=data.get("id", fname.replace(".json", "")),
                    name=data.get("name", fname.replace(".json", "")),
                    category=data.get("category", "business"),
                    preview=data.get("preview", ""),
                    width=data.get("width", 960),
                    height=data.get("height", 540),
                    slide_count=len(data.get("slides", [])),
                    is_premium=False,
                    source="local",
                    tags=data.get("tags", []),
                    data=data,
                )
                db.add(tpl)
                imported += 1
            except Exception as e:
                logger.warning(f"[templates] Failed to import {fname}: {e}")

        if imported > 0:
            await db.flush()
            logger.info(f"[templates] Imported {imported} templates from {template_dir}")
        else:
            _seed_builtin_templates(db)
    except Exception as e:
        logger.warning(f"[templates] Seed from files failed: {e}")
        _seed_builtin_templates(db)


def _seed_builtin_templates(db: AsyncSession) -> None:
    builtin = [
        PPTTemplate(
            id="tpl_business_blue",
            name="蓝色商务",
            category="business",
            preview="",
            width=960,
            height=540,
            slide_count=6,
            is_premium=False,
            source="builtin",
            tags=["商务", "蓝色"],
            data=None,
        ),
        PPTTemplate(
            id="tpl_creative_gradient",
            name="渐变创意",
            category="creative",
            preview="",
            width=960,
            height=540,
            slide_count=5,
            is_premium=False,
            source="builtin",
            tags=["创意", "渐变"],
            data=None,
        ),
        PPTTemplate(
            id="tpl_minimal_white",
            name="极简白",
            category="minimal",
            preview="",
            width=960,
            height=540,
            slide_count=4,
            is_premium=False,
            source="builtin",
            tags=["极简", "白色"],
            data=None,
        ),
        PPTTemplate(
            id="tpl_tech_dark",
            name="深色科技",
            category="tech",
            preview="",
            width=960,
            height=540,
            slide_count=6,
            is_premium=False,
            source="builtin",
            tags=["科技", "深色"],
            data=None,
        ),
        PPTTemplate(
            id="tpl_education_green",
            name="绿色教育",
            category="education",
            preview="",
            width=960,
            height=540,
            slide_count=5,
            is_premium=False,
            source="builtin",
            tags=["教育", "绿色"],
            data=None,
        ),
    ]
    for tpl in builtin:
        db.add(tpl)
    logger.info(f"[templates] Seeded {len(builtin)} built-in templates")
