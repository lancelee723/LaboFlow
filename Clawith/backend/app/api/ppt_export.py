"""Pro Slides PPTX Export API."""

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.database import get_db
from app.models.export_job import ExportJob
from app.models.user import User
from app.services.ppt_export_service import execute_export_job

router = APIRouter(prefix="/ppt/export", tags=["ppt-export"])


class ExportRequest(BaseModel):
    presentation_id: str
    render_mode: str = Field(default="hybrid", pattern=r"^(editable|hybrid|visual)$")


class ExportResponse(BaseModel):
    job_id: str
    status: str


class ExportStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: int
    error: str | None = None


@router.post("/pptx", response_model=ExportResponse)
async def create_export(
    req: ExportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a PPTX export job."""
    job = ExportJob(
        presentation_id=uuid.UUID(req.presentation_id),
        creator_id=current_user.id,
        render_mode=req.render_mode,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    # Start background export
    asyncio_create = __import__("asyncio").create_task
    asyncio_create(execute_export_job(job.id))

    return ExportResponse(job_id=str(job.id), status="pending")


@router.get("/pptx/{job_id}/status", response_model=ExportStatusResponse)
async def get_export_status(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Poll export job status."""
    result = await db.execute(
        select(ExportJob).where(ExportJob.id == uuid.UUID(job_id))
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")

    return ExportStatusResponse(
        job_id=str(job.id),
        status=job.status,
        progress=job.progress,
        error=job.error,
    )


@router.get("/pptx/{job_id}/download")
async def download_export(
    job_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download the exported PPTX file."""
    result = await db.execute(
        select(ExportJob).where(ExportJob.id == uuid.UUID(job_id))
    )
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail=f"Export not ready (status: {job.status})")
    if not job.file_path or not Path(job.file_path).exists():
        raise HTTPException(status_code=404, detail="Export file not found")

    return FileResponse(
        job.file_path,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=f"presentation-{job_id}.pptx",
    )