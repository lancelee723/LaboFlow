"""In-process registry of running pipeline tasks. Single-worker MVP.

Replace with Redis pub/sub when scaling to multi-worker."""

import asyncio
import logging
from collections.abc import Coroutine

logger = logging.getLogger(__name__)


class TaskRegistry:
    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}

    def register(self, session_id: str, coro: Coroutine) -> asyncio.Task:
        task = asyncio.create_task(coro, name=f"pipeline-{session_id}")
        self._tasks[session_id] = task

        def _on_done(t: asyncio.Task) -> None:
            self._tasks.pop(session_id, None)
            if t.cancelled():
                logger.info("Pipeline task cancelled for session %s", session_id)
            elif t.exception() is not None:
                logger.error("Pipeline task failed for session %s: %s", session_id, t.exception())

        task.add_done_callback(_on_done)
        return task

    def cancel(self, session_id: str) -> bool:
        task = self._tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    def running_session_ids(self) -> set[str]:
        return {sid for sid, t in self._tasks.items() if not t.done()}


task_registry = TaskRegistry()
