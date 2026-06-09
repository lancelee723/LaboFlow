"""Tests for the manifest watcher."""
import asyncio
import json
from pathlib import Path

import pytest

from pptmaster.agent.image_watcher import watch_manifest_updates


@pytest.mark.asyncio
async def test_watcher_pushes_changed_items(tmp_path, monkeypatch):
    manifest_path = tmp_path / "image_prompts.json"
    manifest_path.write_text(json.dumps({
        "items": [
            {"filename": "a.png", "status": "Pending"},
            {"filename": "b.png", "status": "Pending"},
        ],
    }))

    pushed = []
    class FakeWsManager:
        async def send_event(self, session_id, event_type, data):
            pushed.append((event_type, data))
    monkeypatch.setattr(
        "pptmaster.agent.image_watcher.ws_manager",
        FakeWsManager(),
    )

    sentinel = asyncio.Event()

    async def driver():
        await asyncio.sleep(0.5)
        # Update manifest with new status
        manifest_path.write_text(json.dumps({
            "items": [
                {"filename": "a.png", "status": "Generated"},
                {"filename": "b.png", "status": "Pending"},
            ],
        }))
        await asyncio.sleep(1.5)
        sentinel.set()

    await asyncio.gather(
        watch_manifest_updates(manifest_path, "session-x", sentinel, poll_seconds=0.3),
        driver(),
    )

    types = [t for t, _ in pushed]
    assert "image_status_update" in types
    # Only a.png should have been pushed (b.png never changed past Pending baseline,
    # which was emitted on first scan)
    a_pushes = [d for t, d in pushed if t == "image_status_update" and d["item"]["filename"] == "a.png"]
    assert any(p["item"]["status"] == "Generated" for p in a_pushes)


@pytest.mark.asyncio
async def test_watcher_tolerates_partial_writes(tmp_path, monkeypatch):
    """If the CLI is mid-write, json.loads will fail — watcher must not crash."""
    manifest_path = tmp_path / "image_prompts.json"
    manifest_path.write_text("{ partial json")

    pushed = []
    class FakeWsManager:
        async def send_event(self, session_id, event_type, data):
            pushed.append((event_type, data))
    monkeypatch.setattr(
        "pptmaster.agent.image_watcher.ws_manager",
        FakeWsManager(),
    )

    sentinel = asyncio.Event()

    async def driver():
        await asyncio.sleep(0.4)
        sentinel.set()

    # Should not raise
    await asyncio.gather(
        watch_manifest_updates(manifest_path, "s", sentinel, poll_seconds=0.2),
        driver(),
    )


@pytest.mark.asyncio
async def test_watcher_stops_on_sentinel(tmp_path, monkeypatch):
    manifest_path = tmp_path / "image_prompts.json"
    manifest_path.write_text(json.dumps({"items": []}))

    class FakeWsManager:
        async def send_event(self, *a, **kw): pass
    monkeypatch.setattr(
        "pptmaster.agent.image_watcher.ws_manager", FakeWsManager(),
    )

    sentinel = asyncio.Event()
    sentinel.set()  # already set — watcher should return immediately
    await asyncio.wait_for(
        watch_manifest_updates(manifest_path, "s", sentinel, poll_seconds=0.5),
        timeout=1.0,
    )
