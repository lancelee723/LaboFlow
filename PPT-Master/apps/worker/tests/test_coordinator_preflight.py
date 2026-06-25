"""Verify that when the user submits a different page_count at preflight_review,
coordinator routes back to strategist_finalize instead of advancing to step 6."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langgraph.types import Command

from pptmaster.agent.coordinator import step_5_5_preflight_review


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _R:
    def __init__(self, c):
        self.content = c


def _make_state(
    *,
    page_count: int | None = 10,
    page_count_reasoning: str | None = "AI chose 10 pages based on source structure.",
    page_count_mode: str | None = "ai_decide",
    user_brief: str = "Test brief",
    template_mode: str = "free_design",
    template_path: str | None = None,
) -> dict:
    return {
        "project_id": "test-project",
        "session_id": "test-session",
        "user_brief": user_brief,
        "template_mode": template_mode,
        "template_path": template_path,
        "page_count": page_count,
        "page_count_reasoning": page_count_reasoning,
        "page_count_mode": page_count_mode,
        "completed_steps": [1, 2, 3, 4, 5],
        "messages": [],
    }


def _fake_settings(tmp_path: Path):
    """Return a fake settings object pointing storage_root at tmp_path."""
    s = MagicMock()
    s.storage_root = str(tmp_path)
    return s


def _write_outline(tmp_path: Path, project_id: str, n_pages: int) -> None:
    """Write a minimal outline.json so preflight can read it."""
    base = tmp_path / "projects" / project_id
    base.mkdir(parents=True, exist_ok=True)
    pages = [
        {
            "index": i,
            "name": f"page_{i:02d}",
            "title": f"Page {i}",
            "type": "content",
            "layout_basename": None,
            "rhythm": "dense",
            "chart_basename": None,
            "content": [],
        }
        for i in range(1, n_pages + 1)
    ]
    (base / "outline.json").write_text(
        json.dumps({"canvas": {"format": "ppt169", "width": 1280, "height": 720}, "pages": pages}),
        encoding="utf-8",
    )
    (base / "spec_lock.md").write_text("## canvas\n- format: ppt169\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Test 1: page_count_change with a new value routes to step_4b_re_finalize
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preflight_page_count_change_routes_to_re_finalize(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """When user submits page_count_change=18 (different from state.page_count=10),
    step_5_5_preflight_review must return Command(goto='step_4b_re_finalize', update=...)."""

    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings",
        lambda: _fake_settings(tmp_path),
    )
    _write_outline(tmp_path, "test-project", n_pages=10)

    state = _make_state(page_count=10)

    user_response = {"page_count_change": 18}

    with patch("pptmaster.agent.coordinator.interrupt", side_effect=lambda _: user_response):
        result = await step_5_5_preflight_review(state)

    # Must be a Command (routing object), not a plain dict
    assert isinstance(result, Command), (
        f"Expected Command, got {type(result)}: {result!r}"
    )
    assert result.goto == "step_4b_re_finalize", (
        f"Expected goto='step_4b_re_finalize', got goto={result.goto!r}"
    )
    assert result.update is not None
    assert result.update.get("page_count") == 18
    # Reasoning must mention the old count
    reasoning = result.update.get("page_count_reasoning", "")
    assert "10" in reasoning or "override" in reasoning.lower(), (
        f"Unexpected reasoning: {reasoning!r}"
    )


# ---------------------------------------------------------------------------
# Test 2: page_count_change equal to current count does NOT re-route
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preflight_same_page_count_does_not_re_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """When user submits page_count_change equal to current page_count, no re-finalize."""

    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings",
        lambda: _fake_settings(tmp_path),
    )
    _write_outline(tmp_path, "test-project", n_pages=10)

    state = _make_state(page_count=10)
    user_response = {"page_count_change": 10}  # same value

    with patch("pptmaster.agent.coordinator.interrupt", side_effect=lambda _: user_response):
        result = await step_5_5_preflight_review(state)

    # Should advance normally (plain dict with current_step=6)
    assert not isinstance(result, Command), (
        f"Expected plain dict (no re-route), got Command: {result!r}"
    )
    assert isinstance(result, dict)
    assert result.get("current_step") == 6


# ---------------------------------------------------------------------------
# Test 3: no page_count_change key at all does NOT re-route
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preflight_no_page_count_change_does_not_re_route(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """When user sends the standard approval (no page_count_change), no re-finalize."""

    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings",
        lambda: _fake_settings(tmp_path),
    )
    _write_outline(tmp_path, "test-project", n_pages=10)

    state = _make_state(page_count=10)
    user_response = {"decision": "approve"}  # normal approval, no page_count_change

    with patch("pptmaster.agent.coordinator.interrupt", side_effect=lambda _: user_response):
        result = await step_5_5_preflight_review(state)

    assert not isinstance(result, Command), (
        f"Expected plain dict (no re-route), got Command: {result!r}"
    )
    assert isinstance(result, dict)
    assert result.get("current_step") == 6


# ---------------------------------------------------------------------------
# Test 4: payload includes page_count, page_count_reasoning, page_count_mode
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preflight_payload_includes_new_fields(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The interrupt payload must include page_count, page_count_reasoning, page_count_mode."""

    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings",
        lambda: _fake_settings(tmp_path),
    )
    _write_outline(tmp_path, "test-project", n_pages=10)

    state = _make_state(
        page_count=10,
        page_count_reasoning="AI chose 10 pages.",
        page_count_mode="ai_decide",
    )

    captured: list[dict] = []

    def _capturing_interrupt(payload: dict):
        captured.append(payload)
        # Return normal approval (no re-route)
        return {"decision": "approve"}

    with patch("pptmaster.agent.coordinator.interrupt", side_effect=_capturing_interrupt):
        await step_5_5_preflight_review(state)

    assert captured, "interrupt() was not called"
    payload = captured[0]
    assert payload.get("gate") == "preflight_review"
    preflight_data = payload.get("preflight_data", {})
    assert preflight_data.get("page_count") == 10, (
        f"page_count missing from preflight_data: {preflight_data}"
    )
    assert preflight_data.get("page_count_reasoning") == "AI chose 10 pages.", (
        f"page_count_reasoning missing or wrong: {preflight_data}"
    )
    assert preflight_data.get("page_count_mode") == "ai_decide", (
        f"page_count_mode missing or wrong: {preflight_data}"
    )


# ---------------------------------------------------------------------------
# Test 5: out-of-range page_count_change is ignored (no re-route)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_preflight_out_of_range_page_count_change_ignored(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """page_count_change outside 3..100 must NOT trigger re-finalize."""

    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings",
        lambda: _fake_settings(tmp_path),
    )
    _write_outline(tmp_path, "test-project", n_pages=10)

    state = _make_state(page_count=10)

    for bad_value in [2, 101, 0, -5]:
        user_response = {"page_count_change": bad_value}
        with patch("pptmaster.agent.coordinator.interrupt", side_effect=lambda _: user_response):
            result = await step_5_5_preflight_review(state)

        assert not isinstance(result, Command), (
            f"page_count_change={bad_value} should not trigger Command, got {result!r}"
        )
