"""WebSocket routes for session streaming — with history replay."""
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from pptmaster.db.models import SessionEvent
from pptmaster.db.session import get_async_session_factory
from pptmaster.ws.manager import ws_manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])


@router.websocket("/ws/sessions/{session_id}")
async def session_websocket(websocket: WebSocket, session_id: str, since: str | None = None):
    await ws_manager.connect(session_id, websocket)  # register first — live events not lost

    # ---- replay history ----
    # If the client supplies ?since=<id>, skip events the FE has already processed
    # in a prior connection (cursor-based replay). Prevents re-triggering
    # side-effectful handlers (e.g. agent_error → setSessionId(null)) on reconnect.
    try:
        async with get_async_session_factory()() as db:
            query = (
                select(SessionEvent)
                .where(SessionEvent.session_id == session_id)
            )
            if since:
                query = query.where(SessionEvent.id > since)
            query = query.order_by(SessionEvent.created_at, SessionEvent.id)
            rows = (await db.execute(query)).scalars().all()

        for row in rows:
            await websocket.send_text(json.dumps({
                "type": row.event_type,
                "_id": row.id,
                **row.payload,
            }))
    except Exception:
        logger.warning("replay failed for %s", session_id, exc_info=True)

    # ---- live loop ----
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(session_id, websocket)
