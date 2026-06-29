"""When generate_notes=False, step_6_executor must NOT call the LLM for speaker notes
and must NOT write notes/total.md. When True, current behavior preserved.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from pptmaster.agent import coordinator


@pytest.fixture
def fake_step_6_env(monkeypatch, tmp_path):
    fake_settings = MagicMock()
    fake_settings.storage_root = str(tmp_path)
    fake_settings.database_url = "postgresql+asyncpg://u:p@h/d"
    monkeypatch.setattr(coordinator, "get_settings", lambda: fake_settings)
    return tmp_path


async def test_notes_skipped_when_generate_notes_false(monkeypatch, fake_step_6_env):
    """generate_notes=False -> no LLM call, no total.md file."""
    project_id = "test-proj"
    base = fake_step_6_env / "projects" / project_id
    base.mkdir(parents=True, exist_ok=True)

    called = []
    fake_model = MagicMock()
    async def fake_invoke(prompt):
        called.append(prompt)
        m = MagicMock()
        m.content = "should not be reached"
        return m
    fake_model.ainvoke = fake_invoke

    await coordinator._maybe_write_speaker_notes(
        model=fake_model,
        pages=[{"index": 1, "type": "cover", "title": "x"}],
        base_path=base,
        generate_notes=False,
    )

    assert called == [], "LLM must not be called when notes disabled"
    assert not (base / "notes" / "total.md").exists()


async def test_notes_written_when_generate_notes_true(monkeypatch, fake_step_6_env):
    project_id = "test-proj-2"
    base = fake_step_6_env / "projects" / project_id
    base.mkdir(parents=True, exist_ok=True)

    fake_model = MagicMock()
    async def fake_invoke(prompt):
        m = MagicMock()
        m.content = "# 01_cover\nIntro line."
        return m
    fake_model.ainvoke = fake_invoke

    msg = await coordinator._maybe_write_speaker_notes(
        model=fake_model,
        pages=[{"index": 1, "type": "cover", "title": "x"}],
        base_path=base,
        generate_notes=True,
    )

    assert (base / "notes" / "total.md").read_text(encoding="utf-8") == "# 01_cover\nIntro line."
    assert "Speaker notes written" in msg
