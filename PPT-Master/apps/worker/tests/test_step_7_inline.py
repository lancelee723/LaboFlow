"""Verify step_7 wrappers are importable and step_7 handles errors."""
import pytest
from pathlib import Path


def test_total_md_split_wrapper_is_importable():
    from pptmaster.scripts.total_md_split import run as split_run
    assert callable(split_run)


def test_finalize_svg_wrapper_is_importable():
    from pptmaster.scripts.finalize_svg import run as finalize_run
    assert callable(finalize_run)


def test_svg_to_pptx_wrapper_is_importable():
    from pptmaster.scripts.svg_to_pptx import run as export_run
    assert callable(export_run)


@pytest.mark.asyncio
async def test_step_7_does_not_write_completed_on_script_failure(monkeypatch, tmp_path: Path):
    """When a post-processing script raises, completed_steps should NOT include 7."""
    from pptmaster.agent.coordinator import step_7_post_processing

    proj_path = tmp_path / "projects" / "proj-x"
    (proj_path / "svg_output").mkdir(parents=True)
    (proj_path / "svg_output" / "01_test.svg").write_text("<svg></svg>", encoding="utf-8")

    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings",
        lambda: type("S", (), {"storage_root": str(tmp_path)})(),
    )

    def _failing_run(_path):
        raise RuntimeError("simulated script failure")
    monkeypatch.setattr(
        "pptmaster.agent.coordinator._split_notes_run",
        _failing_run,
    )
    monkeypatch.setattr(
        "pptmaster.agent.coordinator._finalize_svg_run",
        _failing_run,
    )
    monkeypatch.setattr(
        "pptmaster.agent.coordinator._svg_to_pptx_run",
        _failing_run,
    )

    state = {
        "project_id": "proj-x",
        "session_id": "sess-x",
        "messages": [],
        "current_step": 7,
        "completed_steps": [1, 2, 3, 4, 5, 6],
    }

    result = await step_7_post_processing(state)
    assert 7 not in result.get("completed_steps", []), \
        "completed_steps must NOT include 7 when a script failed"
    assert any("simulated script failure" in m.get("content", "")
               for m in result.get("messages", [])), \
        "error message should be in state.messages"
