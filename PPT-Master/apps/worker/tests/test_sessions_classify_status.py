"""Unit tests for _classify_status — 6-state session lifecycle machine.

Covers all six states and edge cases per Track B spec:
  running / waiting_for_input / interrupted / aborted / failed / completed
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from pptmaster.api.sessions import _classify_status


def _session(
    *,
    status_locked: str | None = None,
    abort_reason: str | None = None,
    is_interrupted: bool = False,
) -> MagicMock:
    """Build a minimal session row mock."""
    row = MagicMock()
    row.status_locked = status_locked
    row.abort_reason = abort_reason
    row.is_interrupted = is_interrupted
    return row


# ── completed ────────────────────────────────────────────────────────────────

def test_completed_via_status_locked():
    """status_locked='completed' → completed, regardless of other flags."""
    result = _classify_status(
        session_row=_session(status_locked="completed"),
        is_running=False,
        completed_steps=[1, 2, 3],
    )
    assert result["status"] == "completed"
    assert result["current_step"] == 7
    assert result["abort_reason"] is None


def test_completed_via_step_7_in_completed_steps():
    """7 in completed_steps → completed even without status_locked."""
    result = _classify_status(
        session_row=_session(),
        is_running=False,
        completed_steps=[1, 2, 3, 4, 5, 6, 7],
    )
    assert result["status"] == "completed"
    assert result["current_step"] == 7


def test_completed_beats_is_running():
    """status_locked='completed' wins even if is_running=True (race at task cancel)."""
    result = _classify_status(
        session_row=_session(status_locked="completed"),
        is_running=True,
        completed_steps=[],
    )
    assert result["status"] == "completed"


# ── aborted ──────────────────────────────────────────────────────────────────

def test_aborted_via_status_locked():
    """status_locked='aborted' → aborted with abort_reason propagated."""
    result = _classify_status(
        session_row=_session(status_locked="aborted", abort_reason="Cancelled by user"),
        is_running=False,
        completed_steps=[1, 2],
    )
    assert result["status"] == "aborted"
    assert result["abort_reason"] == "Cancelled by user"


def test_aborted_abort_reason_none_when_not_set():
    """aborted without an abort_reason returns abort_reason=None."""
    result = _classify_status(
        session_row=_session(status_locked="aborted", abort_reason=None),
        is_running=False,
        completed_steps=[],
    )
    assert result["status"] == "aborted"
    assert result["abort_reason"] is None


def test_aborted_beats_is_interrupted():
    """status_locked='aborted' wins even if is_interrupted=True (shouldn't happen, but safe)."""
    result = _classify_status(
        session_row=_session(status_locked="aborted", is_interrupted=True),
        is_running=False,
        completed_steps=[],
    )
    assert result["status"] == "aborted"


# ── failed ───────────────────────────────────────────────────────────────────

def test_failed_via_status_locked():
    """status_locked='failed' → failed with abort_reason (exception string)."""
    result = _classify_status(
        session_row=_session(status_locked="failed", abort_reason="ZeroDivisionError: division by zero"),
        is_running=False,
        completed_steps=[1, 2, 3],
    )
    assert result["status"] == "failed"
    assert result["abort_reason"] == "ZeroDivisionError: division by zero"
    assert result["current_step"] == 3


# ── running ──────────────────────────────────────────────────────────────────

def test_running_when_task_active_no_lock():
    """No status_locked, is_running=True → running."""
    result = _classify_status(
        session_row=_session(),
        is_running=True,
        completed_steps=[1, 2],
    )
    assert result["status"] == "running"
    assert result["current_step"] == 2
    assert result["abort_reason"] is None


def test_running_current_step_from_completed_steps():
    """current_step is max of completed_steps while running."""
    result = _classify_status(
        session_row=_session(),
        is_running=True,
        completed_steps=[1, 2, 3, 4, 5],
    )
    assert result["status"] == "running"
    assert result["current_step"] == 5


# ── waiting_for_input ────────────────────────────────────────────────────────

def test_waiting_for_input_when_is_interrupted():
    """is_interrupted=True, no task → waiting_for_input."""
    result = _classify_status(
        session_row=_session(is_interrupted=True),
        is_running=False,
        completed_steps=[1, 2, 3],
    )
    assert result["status"] == "waiting_for_input"
    assert result["current_step"] == 3
    assert result["abort_reason"] is None


# ── interrupted (fallback) ────────────────────────────────────────────────────

def test_interrupted_fallback_no_lock_no_task_no_gate():
    """No status_locked, not running, is_interrupted=False → interrupted (tab-close)."""
    result = _classify_status(
        session_row=_session(),
        is_running=False,
        completed_steps=[1, 2, 3, 4],
    )
    assert result["status"] == "interrupted"
    assert result["current_step"] == 4


def test_interrupted_fallback_empty_completed_steps():
    """Fallback with no steps completed → current_step=0."""
    result = _classify_status(
        session_row=_session(),
        is_running=False,
        completed_steps=[],
    )
    assert result["status"] == "interrupted"
    assert result["current_step"] == 0


# ── edge cases ───────────────────────────────────────────────────────────────

def test_completed_steps_included_in_all_responses():
    """completed_steps list is always echoed back in the response."""
    steps = [1, 2, 3]
    result = _classify_status(
        session_row=_session(),
        is_running=True,
        completed_steps=steps,
    )
    assert result["completed_steps"] == steps


def test_step_7_without_status_locked_still_completes():
    """Handles the race where step_7 completed but status_locked wasn't set yet."""
    result = _classify_status(
        session_row=_session(status_locked=None),
        is_running=False,
        completed_steps=[1, 2, 3, 4, 5, 6, 7],
    )
    assert result["status"] == "completed"
    assert result["current_step"] == 7
