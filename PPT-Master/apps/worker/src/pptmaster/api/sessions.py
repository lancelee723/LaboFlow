"""Session management API routes."""

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.api._errors import AppError, ErrorCode
from pptmaster.auth.middleware import AuthContext, get_auth_context, require_creator
from pptmaster.db.models import Project, Session
from pptmaster.db.session import open_db_session
from pptmaster.ws.manager import ws_manager

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class CreateSessionRequest(BaseModel):
    project_id: str


class SessionResponse(BaseModel):
    id: str
    project_id: str
    thread_id: str
    current_step: int | None
    is_interrupted: bool
    started_at: str | None


class SessionStatusResponse(BaseModel):
    status: str  # "running" | "waiting_for_input" | "interrupted" | "aborted" | "failed" | "completed"
    current_step: int
    completed_steps: list[int]
    abort_reason: str | None = None


def _classify_status(
    session_row: Session,
    is_running: bool,
    completed_steps: list[int],
) -> dict:
    """Classify session status using the 6-state machine.

    Priority order (highest wins):
      1. Explicit terminal lock (status_locked column) or step-7 completion
      2. Live running state (task_registry check)
      3. Gate-interrupted state (is_interrupted flag)
      4. Fallback: ended without status_locked → treat as interrupted
         (recovery overlay lets user resume or reset)
    """
    current_step = max(completed_steps) if completed_steps else 0

    # ── 1. Explicit terminal status wins ────────────────────────────────────
    if session_row.status_locked == "completed" or 7 in completed_steps:
        return {
            "status": "completed",
            "current_step": 7,
            "completed_steps": completed_steps,
            "abort_reason": None,
        }

    if session_row.status_locked == "aborted":
        return {
            "status": "aborted",
            "current_step": current_step,
            "completed_steps": completed_steps,
            "abort_reason": session_row.abort_reason,
        }

    if session_row.status_locked == "failed":
        return {
            "status": "failed",
            "current_step": current_step,
            "completed_steps": completed_steps,
            "abort_reason": session_row.abort_reason,
        }

    # ── 2. Live running state ────────────────────────────────────────────────
    if is_running:
        return {
            "status": "running",
            "current_step": current_step,
            "completed_steps": completed_steps,
            "abort_reason": None,
        }

    # ── 3. Gate-interrupted (pipeline parked waiting for user input) ─────────
    if session_row.is_interrupted:
        return {
            "status": "waiting_for_input",
            "current_step": current_step,
            "completed_steps": completed_steps,
            "abort_reason": None,
        }

    # ── 4. Fallback — session ended without status_locked set ───────────────
    # Typically: user closed the tab while running/waiting_for_input.
    # FE treats this as interrupted → shows recovery overlay.
    return {
        "status": "interrupted",
        "current_step": current_step,
        "completed_steps": completed_steps,
        "abort_reason": None,
    }


@router.post("", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    request: CreateSessionRequest,
    auth: AuthContext = Depends(require_creator),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == request.project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: can't start session on soft-deleted project
            )
        )
        project = result.scalar_one_or_none()

        if not project:
            raise AppError(ErrorCode.PROJECT_NOT_FOUND, "Project not found", status_code=404)

        session_id = str(uuid4())
        thread_id = str(uuid4())

        db_session = Session(
            id=session_id,
            project_id=request.project_id,
            user_id=auth.user_id,
            thread_id=thread_id,
            current_step=project.current_step,
            is_interrupted=False,
        )
        session.add(db_session)
        await session.commit()

        return SessionResponse(
            id=db_session.id,
            project_id=db_session.project_id,
            thread_id=db_session.thread_id,
            current_step=db_session.current_step,
            is_interrupted=db_session.is_interrupted,
            started_at=db_session.started_at.isoformat() if db_session.started_at else None,
        )


@router.get("/running")
async def list_running_sessions(auth: AuthContext = Depends(get_auth_context)):
    """Sessions currently executing in this worker, filtered by org."""
    from pptmaster.agent.task_registry import task_registry
    from pptmaster.db.models import Session as SessionModel, Project as ProjectModel

    running_ids = task_registry.running_session_ids()
    if not running_ids:
        return []

    async with open_db_session() as db:
        rows = (await db.execute(
            select(SessionModel, ProjectModel)
            .join(ProjectModel, SessionModel.project_id == ProjectModel.id)
            .where(
                SessionModel.id.in_(running_ids),
                ProjectModel.owner_id == auth.user_id,
                ProjectModel.soft_deleted_at.is_(None),  # D3: exclude soft-deleted
            )
            .order_by(SessionModel.started_at.desc())
        )).all()

    return [
        {"session_id": s.id, "project_id": p.id, "project_name": p.name, "current_step": s.current_step}
        for s, p in rows
    ]


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        result = await session.execute(select(Session).where(Session.id == session_id))
        db_session = result.scalar_one_or_none()

        if not db_session:
            raise AppError(ErrorCode.SESSION_NOT_FOUND, "Session not found", status_code=404)

        return SessionResponse(
            id=db_session.id,
            project_id=db_session.project_id,
            thread_id=db_session.thread_id,
            current_step=db_session.current_step,
            is_interrupted=db_session.is_interrupted,
            started_at=db_session.started_at.isoformat() if db_session.started_at else None,
        )


@router.post("/{session_id}/stop")
async def stop_session(session_id: str, auth: AuthContext = Depends(require_creator)):
    """Cancel a running or paused pipeline.

    If the pipeline is actively running (e.g. during executor SVG generation),
    the asyncio task receives CancelledError and cleans up.

    If the pipeline is paused at a blocking gate (is_interrupted=True), the
    task already finished — we mark the session aborted and broadcast an
    agent_error to unblock the frontend directly.
    """
    from pptmaster.agent.task_registry import task_registry
    from pptmaster.db.models import Project as ProjectModel, Session as SessionModel

    async with open_db_session() as db:
        result = await db.execute(
            select(SessionModel, ProjectModel)
            .join(ProjectModel, SessionModel.project_id == ProjectModel.id)
            .where(SessionModel.id == session_id, ProjectModel.owner_id == auth.user_id)
        )
        row = result.first()
        if not row:
            raise AppError(ErrorCode.SESSION_NOT_FOUND, "Session not found", status_code=404)

        sess, proj = row

        # Case 1: pipeline is paused at a blocking gate — no active task to cancel.
        if sess.is_interrupted:
            sess.is_interrupted = False
            sess.status_locked = "aborted"
            sess.abort_reason = "Cancelled by user"
            sess.ended_at = datetime.now(timezone.utc)
            proj.status = "aborted"
            await db.commit()
            await ws_manager.broadcast_agent_error(
                session_id, "coordinator", "Cancelled by user", can_resume=False,
            )
            return {"cancelled": True, "session_id": session_id, "was_interrupted": True}

        # Case 2: pipeline is actively running — cancel the asyncio task.
        cancelled = task_registry.cancel(session_id)
        if not cancelled:
            # Task already finished (raced with completion) — mark aborted if
            # project is still in "generating" to avoid leaving stale state.
            if proj.status == "generating":
                proj.status = "aborted"
                sess.status_locked = "aborted"
                sess.abort_reason = "Cancelled by user"
                sess.ended_at = datetime.now(timezone.utc)
                await db.commit()

        return {"cancelled": cancelled, "session_id": session_id}


@router.get("/{session_id}/status", response_model=SessionStatusResponse)
async def get_session_status(
    session_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as db:
        result = await db.execute(select(Session).where(Session.id == session_id))
        db_session = result.scalar_one_or_none()

    if not db_session:
        raise AppError(ErrorCode.SESSION_NOT_FOUND, "Session not found", status_code=404)

    from pptmaster.agent.task_registry import task_registry
    from pptmaster.agent.coordinator import compiled_coordinator

    is_running = session_id in task_registry.running_session_ids()

    completed_steps: list[int] = []
    try:
        async with compiled_coordinator() as graph:
            snapshot = await graph.aget_state({"configurable": {"thread_id": db_session.thread_id}})
            if snapshot and snapshot.values:
                completed_steps = list(snapshot.values.get("completed_steps", []))
    except Exception:
        pass

    return _classify_status(
        session_row=db_session,
        is_running=is_running,
        completed_steps=completed_steps,
    )
