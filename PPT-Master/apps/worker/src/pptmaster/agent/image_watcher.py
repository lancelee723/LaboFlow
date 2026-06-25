"""Manifest watcher coroutine.

While `image_gen.py --manifest` runs as a subprocess, it writes status
updates back to `image_prompts.json`. This watcher polls the file, diffs
items, and pushes per-item updates over the existing WS bus.
"""

import asyncio
import json
import logging
from pathlib import Path

from pptmaster.ws.manager import ws_manager

logger = logging.getLogger(__name__)


def _enrich_item(item: dict, session_id: str, project_id: str | None) -> dict:
    """Add a thumbnail URL when the file is on disk."""
    out = dict(item)
    if item.get("status") in ("Generated", "Sourced", "Existing") and project_id:
        out["thumbnail_url"] = f"/api/projects/{project_id}/images/{item['filename']}"
    return out


async def watch_manifest_updates(
    manifest_path: Path,
    session_id: str,
    sentinel: asyncio.Event,
    project_id: str | None = None,
    poll_seconds: float = 2.0,
) -> None:
    """Poll `manifest_path` and push `image_status_update` events on diff.

    Stops when `sentinel` is set. Tolerates missing / partially-written files.
    """
    last_snapshot: dict[str, dict] = {}

    while not sentinel.is_set():
        try:
            await asyncio.wait_for(sentinel.wait(), timeout=poll_seconds)
            break  # sentinel set during sleep
        except asyncio.TimeoutError:
            pass

        if not manifest_path.is_file():
            continue

        try:
            current = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # CLI mid-write — try again next poll
            continue

        items = current.get("items", []) if isinstance(current, dict) else []
        for item in items:
            filename = item.get("filename")
            if not filename:
                continue
            previous = last_snapshot.get(filename)
            if previous != item:
                enriched = _enrich_item(item, session_id, project_id)
                try:
                    await ws_manager.send_event(
                        session_id,
                        "image_status_update",
                        {"item": enriched},
                    )
                except Exception:
                    logger.warning("image_status_update push failed", exc_info=True)
                last_snapshot[filename] = dict(item)
