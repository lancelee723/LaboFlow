"""PPTX Export Service — background job that renders slides to PPTX."""

import asyncio
import tempfile
import uuid
from pathlib import Path

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.export_job import ExportJob
from app.models.presentation import Presentation
from app.services.document_conversion.chrome_renderer import collect_browser_layout
from app.services.document_conversion.pptx_renderer import render_html_to_pptx


EXPORT_DIR = Path(tempfile.gettempdir()) / "pro-slides-exports"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


async def execute_export_job(job_id: uuid.UUID) -> None:
    """Run the export job: render each slide page via Chrome → PPTX."""
    async with async_session() as db:
        result = await db.execute(select(ExportJob).where(ExportJob.id == job_id))
        job = result.scalar_one_or_none()
        if not job:
            logger.error(f"[export] Job {job_id} not found")
            return

        # Load presentation
        result = await db.execute(select(Presentation).where(Presentation.id == job.presentation_id))
        presentation = result.scalar_one_or_none()
        if not presentation:
            job.status = "failed"
            job.error = "Presentation not found"
            await db.commit()
            return

        content = presentation.content or {}
        slide_id = content.get("slide_id", "")
        if not slide_id:
            job.status = "failed"
            job.error = "No slide_id in presentation content"
            await db.commit()
            return

        job.status = "processing"
        await db.commit()

    try:
        # Build HTML from slide pages
        pages = content.get("pages", [])
        mode = content.get("mode", "freeride")
        direction = content.get("direction", "deep_blue")

        html_content = _build_slide_html(pages, mode, direction, slide_id)

        # Write HTML to temp file
        html_file = EXPORT_DIR / f"{job_id}.html"
        html_file.write_text(html_content, encoding="utf-8")

        # Output PPTX path
        pptx_file = EXPORT_DIR / f"{job_id}.pptx"

        # Render
        await render_html_to_pptx(
            src_file=html_file,
            tgt_file=pptx_file,
            target_path=str(pptx_file),
            ws=EXPORT_DIR,
            arguments={
                "design_width": 1920,
                "design_height": 1080,
                "render_mode": job.render_mode,
                "render_scale": 2.0,
            },
        )

        # Update job as completed
        async with async_session() as db:
            result = await db.execute(select(ExportJob).where(ExportJob.id == job_id))
            job = result.scalar_one_or_none()
            if job:
                job.status = "completed"
                job.progress = 100
                job.file_path = str(pptx_file)
                await db.commit()

        logger.info(f"[export] Job {job_id} completed: {pptx_file}")

    except Exception as e:
        logger.error(f"[export] Job {job_id} failed: {e}")
        async with async_session() as db:
            result = await db.execute(select(ExportJob).where(ExportJob.id == job_id))
            job = result.scalar_one_or_none()
            if job:
                job.status = "failed"
                job.error = str(e)
                await db.commit()


def _build_slide_html(pages: list, mode: str, direction: str, slide_id: str) -> str:
    """Build a simple HTML file with slide pages for Chrome rendering."""
    slides_html = ""
    for i, page in enumerate(pages):
        layout_id = page.get("layout_id", "key_message")
        title = page.get("title", f"Slide {i + 1}")
        notes = page.get("notes", "")

        slides_html += f"""
        <div class="slide" data-slide="{i}" style="width:1920px;height:1080px;position:relative;overflow:hidden;">
          <div style="padding:60px;font-family:Helvetica,Arial,sans-serif;">
            <h1 style="font-size:36px;margin-bottom:24px;">{title}</h1>
            {notes and '<ul style="font-size:20px;line-height:1.8;">' + ''.join(f'<li>{line}</li>' for line in notes.split('\n') if line.strip()) + '</ul>' or ''}
          </div>
        </div>
        """

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body {{ margin: 0; background: #f5f7fa; }}
  .slide {{ background: white; margin: 20px auto; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }}
</style></head><body>
{slides_html}
</body></html>"""