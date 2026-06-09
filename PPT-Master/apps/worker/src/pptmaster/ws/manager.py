"""WebSocket connection manager for session streaming."""

import json
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        self._connections: dict[str, list[WebSocket]] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        if session_id not in self._connections:
            self._connections[session_id] = []
        self._connections[session_id].append(websocket)

    def disconnect(self, session_id: str, websocket: WebSocket) -> None:
        if session_id in self._connections:
            if websocket in self._connections[session_id]:
                self._connections[session_id].remove(websocket)
            if not self._connections[session_id]:
                del self._connections[session_id]

    _PERSIST_TYPES = {
        "agent_message", "tool_call", "tool_result",
        "blocking_gate", "agent_error", "artifact_updated",
        "step_completed", "svg_progress",
        "image_status_update", "image_phase_complete",  # PR2
    }

    async def send_event(self, session_id: str, event_type: str, data: dict[str, Any]) -> None:
        """Broadcast + persist discrete events.  Thinking deltas are NOT persisted
        (broadcast_thinking is a fast path that skips DB)."""
        from uuid import uuid4

        from pptmaster.db.models import SessionEvent
        from pptmaster.db.session import get_async_session_factory

        event_id: str | None = None

        if event_type in self._PERSIST_TYPES:
            try:
                event_id = str(uuid4())
                async with get_async_session_factory()() as db:
                    db.add(SessionEvent(
                        id=event_id,
                        session_id=session_id,
                        event_type=event_type,
                        payload=data,
                    ))
                    await db.commit()
            except Exception:
                import logging
                logging.getLogger(__name__).warning(
                    "session_event persist failed for %s/%s", session_id, event_type
                )
                event_id = None

        # Build wire message (always broadcast, even if persist failed)
        message_payload: dict[str, Any] = {"type": event_type, **data}
        if event_id:
            message_payload["_id"] = event_id

        if session_id not in self._connections:
            return

        message = json.dumps(message_payload)
        dead = []
        for ws in self._connections[session_id]:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for d in dead:
            self.disconnect(session_id, d)

    async def broadcast_thinking(self, session_id: str, agent: str, delta: str) -> None:
        await self.send_event(session_id, "thinking", {"agent": agent, "delta": delta})

    async def broadcast_tool_call(self, session_id: str, agent: str, tool: str, args: dict) -> None:
        await self.send_event(session_id, "tool_call", {"agent": agent, "tool": tool, "args": args})

    async def broadcast_tool_result(
        self, session_id: str, agent: str, tool: str, success: bool, summary: str,
        tokens_in: int = 0, tokens_out: int = 0,
    ) -> None:
        payload: dict[str, Any] = {
            "agent": agent, "tool": tool, "success": success, "summary": summary,
        }
        if tokens_in or tokens_out:
            payload["tokens_in"] = tokens_in
            payload["tokens_out"] = tokens_out
        await self.send_event(session_id, "tool_result", payload)

    async def broadcast_artifact_updated(
        self, session_id: str, project_id: str, path: str, kind: str, change: str
    ) -> None:
        await self.send_event(
            session_id, "artifact_updated",
            {"project_id": project_id, "path": path, "kind": kind, "change": change},
        )

    async def broadcast_svg_progress(
        self, session_id: str, page: int, total: int, filename: str
    ) -> None:
        await self.send_event(session_id, "svg_progress", {
            "page": page,
            "total": total,
            "filename": filename,
        })

    async def broadcast_blocking_gate(
        self, session_id: str, prompt: str, question_form: dict | None = None,
        gate: str | None = None, preflight_data: dict | None = None,
        recommendation: dict | None = None,
    ) -> None:
        await self.send_event(
            session_id, "blocking_gate",
            {"session_id": session_id, "prompt": prompt, "question_form": question_form,
             "gate": gate, "preflight_data": preflight_data,
             "recommendation": recommendation},
        )

    async def broadcast_agent_message(
        self, session_id: str, agent: str, content: str, question_form: dict | None = None
    ) -> None:
        await self.send_event(
            session_id, "agent_message",
            {"agent": agent, "content": content, "question_form": question_form},
        )

    async def broadcast_agent_error(
        self, session_id: str, agent: str, error: str, can_resume: bool
    ) -> None:
        await self.send_event(
            session_id, "agent_error",
            {"agent": agent, "error": error, "can_resume": can_resume},
        )


ws_manager = ConnectionManager()
