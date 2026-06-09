"""Annotation CRUD and batch-submit endpoints for per-page SVG annotations."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.auth.middleware import AuthContext, require_creator
from pptmaster.db.models import Project
from pptmaster.db.session import open_db_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["annotations"])

# ── Disk helpers ─────────────────────────────────────────────────────────────

_ANNOTATIONS_FILENAME = "annotations.json"


def _load_annotations(project_path: Path) -> dict[str, Any]:
    """Read annotations.json; return the parsed dict (empty structure on miss/error)."""
    file = project_path / _ANNOTATIONS_FILENAME
    if not file.is_file():
        return {"annotations": []}
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "annotations" not in data:
            return {"annotations": []}
        return data
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read annotations.json for %s: %s", project_path, exc)
        return {"annotations": []}


def _save_annotations(project_path: Path, data: dict[str, Any]) -> None:
    """Atomic write: write to a temp file then rename."""
    file = project_path / _ANNOTATIONS_FILENAME
    text = json.dumps(data, ensure_ascii=False, indent=2)
    # Write to a sibling temp file, then rename for atomicity
    fd, tmp_path = tempfile.mkstemp(
        dir=str(project_path), prefix=".annotations_tmp_", suffix=".json"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_path, str(file))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Pydantic models ───────────────────────────────────────────────────────────


class AnnotationCreate(BaseModel):
    pageFile: str
    elementId: str
    elementText: str
    annotation: str


class AnnotationEntry(BaseModel):
    id: str
    pageFile: str
    elementId: str
    elementText: str
    annotation: str


class AnnotationListResponse(BaseModel):
    annotations: list[AnnotationEntry]


class SubmitAnnotationsResponse(BaseModel):
    accepted: bool
    modified_pages: int
    errors: list[str]


# ── DB helper ─────────────────────────────────────────────────────────────────


async def _get_project_by_owner(project_id: str, user_id: str) -> Project:
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == project_id,
                Project.owner_id == user_id,
                Project.soft_deleted_at.is_(None),
            )
        )
        project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return project


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/{pid}/annotations", response_model=AnnotationListResponse)
async def list_annotations(
    pid: str,
    auth: AuthContext = Depends(require_creator),
) -> AnnotationListResponse:
    """Return all annotations stored for a project."""
    project = await _get_project_by_owner(pid, auth.user_id)
    data = _load_annotations(Path(project.storage_path))
    return AnnotationListResponse(
        annotations=[AnnotationEntry(**a) for a in data["annotations"]]
    )


@router.post("/{pid}/annotations", response_model=AnnotationEntry, status_code=201)
async def add_annotation(
    pid: str,
    body: AnnotationCreate,
    auth: AuthContext = Depends(require_creator),
) -> AnnotationEntry:
    """Append one annotation and return it with its generated id."""
    project = await _get_project_by_owner(pid, auth.user_id)
    project_path = Path(project.storage_path)

    data = _load_annotations(project_path)
    new_id = str(uuid.uuid4())
    entry: dict[str, str] = {
        "id": new_id,
        "pageFile": body.pageFile,
        "elementId": body.elementId,
        "elementText": body.elementText,
        "annotation": body.annotation,
    }
    data["annotations"].append(entry)
    _save_annotations(project_path, data)

    return AnnotationEntry(**entry)


@router.delete("/{pid}/annotations/{aid}", status_code=204)
async def delete_annotation(
    pid: str,
    aid: str,
    auth: AuthContext = Depends(require_creator),
) -> None:
    """Remove one annotation by id."""
    project = await _get_project_by_owner(pid, auth.user_id)
    project_path = Path(project.storage_path)

    data = _load_annotations(project_path)
    original_len = len(data["annotations"])
    data["annotations"] = [a for a in data["annotations"] if a.get("id") != aid]

    if len(data["annotations"]) == original_len:
        raise HTTPException(status_code=404, detail="Annotation not found")

    _save_annotations(project_path, data)


@router.post("/{pid}/annotations/submit", response_model=SubmitAnnotationsResponse)
async def submit_annotations(
    pid: str,
    auth: AuthContext = Depends(require_creator),
) -> SubmitAnnotationsResponse:
    """Batch-submit all stored annotations.

    For each page that has annotations:
    1. Calls ``regenerate_page()`` to update the SVG via LLM.
    2. Broadcasts ``svg_progress`` after each page.
    After all pages:
    3. Runs finalize_svg + svg_to_pptx.
    4. Broadcasts ``artifact_updated`` for the new PPTX.
    5. Clears annotations.json.
    """
    project = await _get_project_by_owner(pid, auth.user_id)
    project_path = Path(project.storage_path)

    data = _load_annotations(project_path)
    all_annotations = data["annotations"]

    if not all_annotations:
        return SubmitAnnotationsResponse(accepted=True, modified_pages=0, errors=[])

    # Group annotations by pageFile
    from collections import defaultdict

    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for ann in all_annotations:
        grouped[ann["pageFile"]].append(ann)

    # Get LLM model
    from pptmaster.llm.provider import get_chat_model

    try:
        model = await get_chat_model("executor")
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503, detail=f"LLM model unavailable: {exc}"
        ) from exc

    from pptmaster.agent.annotations import regenerate_page
    from pptmaster.ws.manager import ws_manager

    errors: list[str] = []
    modified: list[str] = []
    total_pages = len(grouped)

    # Get a session id for WS broadcasts — best-effort lookup
    session_id = await _find_session_for_project(pid)

    for page_idx, (page_file_name, page_anns) in enumerate(grouped.items(), start=1):
        page_file = project_path / "svg_output" / page_file_name

        # Build {element_id: annotation_text} for this page
        ann_map = {a["elementId"]: a["annotation"] for a in page_anns}

        result = await regenerate_page(
            page_file=page_file,
            annotations=ann_map,
            project_path=project_path,
            model=model,
        )

        if result["success"]:
            modified.append(page_file_name)
        else:
            errors.append(f"{page_file_name}: {result.get('error', 'unknown error')}")

        # Broadcast progress + per-SVG artifact_updated so the FE invalidates
        # the artifact list and refetches with a fresh cache-bust URL.
        if session_id:
            try:
                await ws_manager.broadcast_svg_progress(
                    session_id,
                    page=page_idx,
                    total=total_pages,
                    filename=page_file_name,
                )
            except Exception as exc:
                logger.debug("svg_progress broadcast failed: %s", exc)
            if result["success"]:
                try:
                    await ws_manager.broadcast_artifact_updated(
                        session_id, pid,
                        f"svg_output/{page_file_name}", "svg", "updated",
                    )
                except Exception as exc:
                    logger.debug("artifact_updated broadcast failed: %s", exc)

    # Post-processing: finalize_svg + svg_to_pptx
    post_errors: list[str] = []
    try:
        from pptmaster.scripts.finalize_svg import run as _finalize_svg_run
        from pptmaster.scripts.svg_to_pptx import run as _svg_to_pptx_run

        _finalize_svg_run(project_path)
        _svg_to_pptx_run(project_path)
    except Exception as exc:
        logger.error("Post-processing failed after annotation submit: %s", exc)
        post_errors.append(f"post_processing: {exc}")

    # Broadcast artifact_updated for new PPTX
    pptx_path = project_path / "exports" / "output.pptx"
    if pptx_path.is_file() and session_id:
        try:
            await ws_manager.broadcast_artifact_updated(
                session_id, pid, "exports/output.pptx", "export", "created"
            )
        except Exception as exc:
            logger.debug("artifact_updated broadcast failed: %s", exc)

    # Clear annotations.json on successful completion (even partial successes)
    _save_annotations(project_path, {"annotations": []})

    all_errors = errors + post_errors
    return SubmitAnnotationsResponse(
        accepted=True,
        modified_pages=len(modified),
        errors=all_errors,
    )


async def _find_session_for_project(project_id: str) -> str | None:
    """Best-effort: look up an active session_id for this project via the DB.

    Returns None if not found or on any error — callers handle this gracefully.
    """
    from pptmaster.db.models import Session as DBSession

    try:
        async with open_db_session() as db:
            result = await db.execute(
                select(DBSession).where(
                    DBSession.project_id == project_id,
                    DBSession.status.in_(["running", "waiting_for_input"]),
                )
            )
            sess = result.scalar_one_or_none()
            return str(sess.id) if sess else None
    except Exception:
        return None
