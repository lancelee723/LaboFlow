"""Tests that image-related WS events are persisted (for replay on reconnect)."""
from pptmaster.ws.manager import ConnectionManager


def test_image_events_in_persist_set():
    types = ConnectionManager._PERSIST_TYPES
    assert "image_status_update" in types
    assert "image_phase_complete" in types
