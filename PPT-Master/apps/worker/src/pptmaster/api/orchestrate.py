"""Orchestration API - triggers LangGraph agent execution."""

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, status
from langgraph.types import Command
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.api._errors import AppError, ErrorCode
from pptmaster.agent.coordinator import compiled_coordinator
from pptmaster.agent.task_registry import task_registry
from pptmaster.agent.state import PPTMasterState
from pptmaster.auth.middleware import AuthContext, get_auth_context, require_creator
from pptmaster.db.models import Artifact, ChatMessage, Project, Session
from pptmaster.db.session import open_db_session
from pptmaster.ws.manager import ws_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/orchestrate", tags=["orchestrate"])


def _pending_interrupt_value(state_snapshot) -> dict | None:
    """Read a pending dynamic interrupt from a graph state snapshot.

    LangGraph 1.x's `astream_events(version="v2")` does NOT expose dynamic
    interrupts via `on_chain_end.output.__interrupt__`; it only surfaces them
    on `graph.aget_state(config).tasks[i].interrupts`. Call this after the
    event stream completes to decide whether the graph paused or truly ended.
    """
    tasks = getattr(state_snapshot, "tasks", None) or ()
    for task in tasks:
        interrupts = getattr(task, "interrupts", None) or ()
        for irq in interrupts:
            value = getattr(irq, "value", None)
            if isinstance(value, dict):
                return value
    return None


async def _handle_pending_interrupt(graph, config: dict, session_id: str) -> bool:
    """If the graph paused at a dynamic interrupt, mark the session and broadcast
    a blocking gate. Returns True when paused, False when the graph truly ended."""
    state_snapshot = await graph.aget_state(config)
    pending = _pending_interrupt_value(state_snapshot)
    if pending is None:
        return False

    prompt = pending.get("prompt", "Continue?")
    question_form = pending.get("question_form")
    async with open_db_session() as db:
        row = (await db.execute(select(Session).where(Session.id == session_id))).scalar_one_or_none()
        if row:
            row.is_interrupted = True
            row.interrupt_prompt = {"message": prompt}
            await db.commit()
    await ws_manager.broadcast_blocking_gate(
        session_id, prompt, question_form=question_form,
        gate=pending.get("gate"),
        preflight_data=pending.get("preflight_data"),
        recommendation=pending.get("recommendation"),
    )
    return True


class StartPipelineRequest(BaseModel):
    project_id: str
    source_files: list[str] = []
    user_brief: str = ""


class ResumeRequest(BaseModel):
    session_id: str
    response: dict  # User's response to blocking gate


@router.post("/start")
async def start_pipeline(
    request: StartPipelineRequest,
    auth: AuthContext = Depends(require_creator),
):
    async with open_db_session() as session:
        result = await session.execute(
            select(Project).where(
                Project.id == request.project_id,
                Project.owner_id == auth.user_id,
                Project.soft_deleted_at.is_(None),  # D3: can't start pipeline on soft-deleted project
            )
        )
        project = result.scalar_one_or_none()
        if not project:
            raise AppError(ErrorCode.PROJECT_NOT_FOUND, "Project not found", status_code=404)

        # Pull source artifacts; convert file artifacts to absolute paths,
        # URL artifacts to plain URL strings. request.source_files is ignored
        # (kept on the request schema for backward compat).
        source_rows = (await session.execute(
            select(Artifact)
            .where(
                Artifact.project_id == request.project_id,
                Artifact.kind.in_(["source", "source_url"]),
            )
            .order_by(Artifact.created_at)
        )).scalars().all()

        source_files: list[str] = []
        for a in source_rows:
            if a.kind == "source":
                source_files.append(str(Path(project.storage_path) / a.relative_path))
            else:
                url = (a.meta or {}).get("url")
                if url:
                    source_files.append(url)

        session_id = str(uuid4())
        thread_id = str(uuid4())

        db_session = Session(
            id=session_id,
            project_id=request.project_id,
            user_id=auth.user_id,
            thread_id=thread_id,
            current_step=1,
            is_interrupted=False,
        )
        session.add(db_session)

        project.status = "generating"
        project.current_step = 1
        await session.commit()

    initial_state: PPTMasterState = {
        "project_id": request.project_id,
        "session_id": session_id,
        "user_id": auth.user_id,
        "user_brief": request.user_brief,
        "source_files": source_files,
        "converted_markdown": [],
        "outline": None,
        "design_spec_path": None,
        "spec_lock_path": None,
        "confirmation_progress": {},
        "image_manifest_path": None,
        "generated_images": [],
        "svg_pages": [],
        "quality_results": [],
        "pptx_path": None,
        "current_step": 1,
        "completed_steps": [],
        "messages": [],
    }

    config = {"configurable": {"thread_id": thread_id}}

    task_registry.register(
        session_id,
        _run_pipeline(session_id=session_id, thread_id=thread_id,
                      initial_state=initial_state, config=config),
    )

    return {
        "session_id": session_id,
        "project_id": request.project_id,
        "status": "started",
    }


@router.post("/resume")
async def resume_pipeline(
    request: ResumeRequest,
    auth: AuthContext = Depends(require_creator),
):
    async with open_db_session() as session:
        result = await session.execute(select(Session).where(Session.id == request.session_id))
        db_session = result.scalar_one_or_none()

        if not db_session:
            raise AppError(ErrorCode.SESSION_NOT_FOUND, "Session not found", status_code=404)

        if not db_session.is_interrupted:
            raise AppError(ErrorCode.SESSION_NOT_RESUMABLE, "Session is not waiting for input")

        db_session.is_interrupted = False
        await session.commit()

        thread_id = db_session.thread_id

    config = {"configurable": {"thread_id": thread_id}}

    task_registry.register(
        request.session_id,
        _run_pipeline_resume(session_id=request.session_id, thread_id=thread_id,
                             user_response=request.response, config=config),
    )

    return {"session_id": request.session_id, "status": "resumed"}


async def _run_pipeline(
    session_id: str,
    thread_id: str,
    initial_state: PPTMasterState,
    config: dict,
) -> None:
    """Run the LangGraph pipeline in the background, streaming events via WS."""
    try:
        async with compiled_coordinator() as graph:
            last_step = 0

            async for event in graph.astream_events(initial_state, config=config, version="v2"):
                kind = event.get("event", "")

                # Detect step transitions from node names
                node_name = event.get("name", "")
                step_match = None
                if node_name.startswith("step_"):
                    try:
                        step_match = int(node_name.split("_")[1])
                    except (IndexError, ValueError):
                        pass

                if kind == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk", {})
                    if hasattr(chunk, "content") and chunk.content:
                        await ws_manager.broadcast_thinking(
                            session_id, event.get("name", "agent"), chunk.content
                        )

                elif kind == "on_tool_start":
                    await ws_manager.broadcast_tool_call(
                        session_id,
                        event.get("name", "agent"),
                        event.get("name", "unknown"),
                        event.get("data", {}).get("input", {}),
                    )

                elif kind == "on_tool_end":
                    output = event.get("data", {}).get("output", {})
                    success = output.get("success", True) if isinstance(output, dict) else True
                    summary = str(output)[:200]
                    await ws_manager.broadcast_tool_result(
                        session_id,
                        event.get("name", "agent"),
                        event.get("name", "unknown"),
                        success,
                        summary,
                    )

                elif kind == "on_chain_end":
                    if step_match and step_match != last_step:
                        last_step = step_match
                        await ws_manager.send_event(session_id, "step_completed", {"step": last_step})

            # astream_events ends both at END and at every dynamic interrupt;
            # decide which one happened by inspecting the persisted graph state.
            if await _handle_pending_interrupt(graph, config, session_id):
                return

            # Pipeline truly completed.
            # step_7_post_processing already broadcast the completion message directly;
            # no additional broadcast here to avoid a duplicate FE notification.

            async with open_db_session() as session:
                result = await session.execute(select(Session).where(Session.id == session_id))
                db_session = result.scalar_one_or_none()
                if db_session:
                    db_session.is_interrupted = False
                    db_session.status_locked = "completed"
                    db_session.ended_at = datetime.now(timezone.utc)
                    proj_result = await session.execute(select(Project).where(Project.id == db_session.project_id))
                    project = proj_result.scalar_one_or_none()
                    if project:
                        project.status = "completed"
                        project.current_step = 7
                    await session.commit()

    except asyncio.CancelledError:
        async with open_db_session() as db:
            row = (await db.execute(select(Session).where(Session.id == session_id))).scalar_one_or_none()
            if row:
                row.is_interrupted = False
                row.status_locked = "aborted"
                row.abort_reason = "Cancelled by user"
                row.ended_at = datetime.now(timezone.utc)
                proj = (await db.execute(select(Project).where(Project.id == row.project_id))).scalar_one_or_none()
                if proj:
                    proj.status = "aborted"
            await db.commit()
        await ws_manager.broadcast_agent_error(session_id, "coordinator", "Cancelled by user", can_resume=False)
        raise
    except Exception as e:
        logger.exception("Pipeline execution failed")
        await ws_manager.broadcast_agent_error(session_id, "coordinator", str(e), can_resume=True)

        async with open_db_session() as session:
            result = await session.execute(select(Session).where(Session.id == session_id))
            db_session = result.scalar_one_or_none()
            if db_session:
                db_session.is_interrupted = False
                db_session.status_locked = "failed"  # session terminal state
                db_session.abort_reason = str(e)[:500]
                db_session.ended_at = datetime.now(timezone.utc)
                # Intentional dual-write: project.status must also reflect failure
                # so dashboard queries filtering on project.status do not see the
                # project permanently stuck in "generating".
                proj = (await session.execute(select(Project).where(Project.id == db_session.project_id))).scalar_one_or_none()
                if proj:
                    proj.status = "failed"
                await session.commit()


async def _run_pipeline_resume(
    session_id: str,
    thread_id: str,
    user_response: dict,
    config: dict,
) -> None:
    """Resume a paused pipeline after user input."""
    try:
        async with compiled_coordinator() as graph:
            command = Command(resume=user_response)

            # Resume with user's response
            async for event in graph.astream_events(command, config=config, version="v2"):
                kind = event.get("event", "")

                if kind == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk", {})
                    if hasattr(chunk, "content") and chunk.content:
                        await ws_manager.broadcast_thinking(
                            session_id, event.get("name", "agent"), chunk.content
                        )

                elif kind == "on_tool_start":
                    await ws_manager.broadcast_tool_call(
                        session_id,
                        event.get("name", "agent"),
                        event.get("name", "unknown"),
                        event.get("data", {}).get("input", {}),
                    )

            # Resume re-enters astream_events; same interrupt-detection rule as _run_pipeline.
            if await _handle_pending_interrupt(graph, config, session_id):
                return

            # Pipeline truly completed — step_7_post_processing broadcasts the completion
            # message directly via ws_manager, so no broadcast needed here.

            async with open_db_session() as session:
                result = await session.execute(select(Session).where(Session.id == session_id))
                db_session = result.scalar_one_or_none()
                if db_session:
                    db_session.is_interrupted = False
                    db_session.status_locked = "completed"
                    db_session.ended_at = datetime.now(timezone.utc)
                    proj = (await session.execute(select(Project).where(Project.id == db_session.project_id))).scalar_one_or_none()
                    if proj:
                        proj.status = "completed"
                        proj.current_step = 7
                    await session.commit()

    except asyncio.CancelledError:
        async with open_db_session() as db:
            row = (await db.execute(select(Session).where(Session.id == session_id))).scalar_one_or_none()
            if row:
                row.is_interrupted = False
                row.status_locked = "aborted"
                row.abort_reason = "Cancelled by user"
                row.ended_at = datetime.now(timezone.utc)
                proj = (await db.execute(select(Project).where(Project.id == row.project_id))).scalar_one_or_none()
                if proj:
                    proj.status = "aborted"
            await db.commit()
        await ws_manager.broadcast_agent_error(session_id, "coordinator", "Cancelled by user", can_resume=False)
        raise
    except Exception as e:
        logger.exception("Pipeline resume failed")
        await ws_manager.broadcast_agent_error(session_id, "coordinator", str(e), can_resume=True)

        async with open_db_session() as session:
            result = await session.execute(select(Session).where(Session.id == session_id))
            db_session = result.scalar_one_or_none()
            if db_session:
                db_session.is_interrupted = False
                db_session.status_locked = "failed"  # session terminal state
                db_session.abort_reason = str(e)[:500]
                db_session.ended_at = datetime.now(timezone.utc)
                # Intentional dual-write: project.status must also reflect failure
                # so dashboard queries filtering on project.status do not see the
                # project permanently stuck in "generating".
                proj = (await session.execute(select(Project).where(Project.id == db_session.project_id))).scalar_one_or_none()
                if proj:
                    proj.status = "failed"
                await session.commit()
