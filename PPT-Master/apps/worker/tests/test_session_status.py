"""Session status classification tests — updated for 6-state machine (Track B)."""
from unittest.mock import MagicMock

import pytest


def _session(
    *,
    status_locked: str | None = None,
    abort_reason: str | None = None,
    is_interrupted: bool = False,
) -> MagicMock:
    row = MagicMock()
    row.status_locked = status_locked
    row.abort_reason = abort_reason
    row.is_interrupted = is_interrupted
    return row


@pytest.mark.asyncio
async def test_status_completed_when_step_7_in_completed_steps():
    """If completed_steps contains 7, status is 'completed' regardless of is_interrupted."""
    from pptmaster.api.sessions import _classify_status

    result = _classify_status(
        session_row=_session(),
        is_running=False,
        completed_steps=[1, 2, 3, 4, 5, 6, 7],
    )
    assert result["status"] == "completed"
    assert result["current_step"] == 7


@pytest.mark.asyncio
async def test_status_running_when_task_active():
    """If task_registry has the session, status is 'running'."""
    from pptmaster.api.sessions import _classify_status

    result = _classify_status(
        session_row=_session(),
        is_running=True,
        completed_steps=[1, 2, 3, 4],
    )
    assert result["status"] == "running"
    assert result["current_step"] == 4


@pytest.mark.asyncio
async def test_status_interrupted_when_inactive_and_not_done():
    """Not running, not at gate, not done -> unexpected interruption."""
    from pptmaster.api.sessions import _classify_status

    result = _classify_status(
        session_row=_session(),
        is_running=False,
        completed_steps=[1, 2, 3, 4, 5],
    )
    assert result["status"] == "interrupted"
    assert result["current_step"] == 5


@pytest.mark.asyncio
async def test_status_waiting_for_input_when_interrupted_flag_set():
    """is_interrupted=True (blocking gate) -> waiting_for_input, distinct from crash-interrupted."""
    from pptmaster.api.sessions import _classify_status

    result = _classify_status(
        session_row=_session(is_interrupted=True),
        is_running=False,
        completed_steps=[1, 2, 3],
    )
    assert result["status"] == "waiting_for_input"
