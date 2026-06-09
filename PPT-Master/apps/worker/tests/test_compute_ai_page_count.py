from pathlib import Path
from unittest.mock import patch

import pytest

from pptmaster.agent.strategist import _compute_ai_page_count


@pytest.mark.asyncio
async def test_explicit_mode_is_noop():
    state = {
        "page_count_mode": "explicit",
        "page_count": 12,
        "converted_markdown": [],
    }
    result = await _compute_ai_page_count(state)
    assert result == {"current_step": 4}


@pytest.mark.asyncio
async def test_ai_decide_with_user_override_is_noop():
    """When page_count is already set (user overrode via preflight), do not recompute."""
    state = {
        "page_count_mode": "ai_decide",
        "page_count": 9,  # set by preflight override
        "converted_markdown": [],
    }
    result = await _compute_ai_page_count(state)
    assert result == {"current_step": 4}


@pytest.mark.asyncio
async def test_pre_divided_source_skips_llm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """When source has explicit 第N页/Page N markers, return chunk count without LLM."""
    src = tmp_path / "src.md"
    src.write_text("## 第1页\nIntro\n## 第2页\nBody\n## 第3页\nEnd\n", encoding="utf-8")

    # Sentinel to assert the model is never called
    call_count = {"n": 0}

    class ExplodingModel:
        async def ainvoke(self, prompt):  # pragma: no cover - must never run
            call_count["n"] += 1
            raise AssertionError("LLM should not be called for pre-divided sources")

    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_chat_model",
        lambda role: ExplodingModel(),
    )

    state = {
        "page_count_mode": "ai_decide",
        "page_count": None,
        "converted_markdown": [str(src)],
    }

    result = await _compute_ai_page_count(state)
    assert result["page_count"] == 3
    assert "pre-divided" in result["page_count_reasoning"].lower()
    assert call_count["n"] == 0


class FakeJsonModel:
    def __init__(self, json_str: str):
        self._json = json_str

    async def ainvoke(self, prompt):
        class _R:
            def __init__(self, c): self.content = c
        return _R(self._json)


async def _fake_get_chat_model_factory(fake_model):
    """Return an async callable that always yields `fake_model`."""
    async def _get(role):
        return fake_model
    return _get


@pytest.mark.asyncio
async def test_llm_happy_path_returns_count_and_reasoning(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Source without page markers → LLM returns valid JSON → state is updated."""
    src = tmp_path / "src.md"
    src.write_text("# Topic A\nLorem ipsum\n# Topic B\nDolor sit amet\n", encoding="utf-8")

    fake = FakeJsonModel('{"count": 17, "reasoning": "Five chapters plus cover, ToC, and conclusion."}')

    async def _fake_get_chat_model(role):
        return fake

    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_chat_model",
        _fake_get_chat_model,
    )

    state = {
        "page_count_mode": "ai_decide",
        "page_count": None,
        "converted_markdown": [str(src)],
        "user_brief": "Aim for a 15-20 page deck.",
        "messages": [{"role": "assistant", "content": "Canvas: 16:9 confirmed."}],
    }

    result = await _compute_ai_page_count(state)
    assert result["page_count"] == 17
    assert "Five chapters" in result["page_count_reasoning"]


@pytest.mark.asyncio
async def test_llm_strips_markdown_fences(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    src = tmp_path / "src.md"
    src.write_text("# Topic\n", encoding="utf-8")

    fake = FakeJsonModel('```json\n{"count": 8, "reasoning": "Fenced output."}\n```')

    async def _fake_get_chat_model(role):
        return fake

    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_chat_model",
        _fake_get_chat_model,
    )

    state = {
        "page_count_mode": "ai_decide",
        "page_count": None,
        "converted_markdown": [str(src)],
    }

    result = await _compute_ai_page_count(state)
    assert result["page_count"] == 8


@pytest.mark.asyncio
async def test_llm_garbage_falls_back_to_page_markers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """LLM returns garbage but source has 'Page N' markers buried in prose."""
    # Use a source with exactly ONE page marker heading so chunk_sources classifies it as
    # "undivided" (detect_source_type requires >= 2 markers for pre_divided), but
    # _count_pages_in_sources still finds the max page index via the same lenient regex.
    # A single "#### Page 3: End" means _count_pages_in_sources returns 3 (the max index).
    src = tmp_path / "src.md"
    src.write_text(
        "# Overview\nThis briefing covers three topics.\n\n"
        "## Introduction\nFirst topic content here.\n\n"
        "## Middle\nSecond topic content here.\n\n"
        "#### Page 3: End\nFinal content here.\n",
        encoding="utf-8",
    )

    fake = FakeJsonModel("totally not json")

    async def _fake_get_chat_model(role):
        return fake

    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_chat_model",
        _fake_get_chat_model,
    )

    state = {
        "page_count_mode": "ai_decide",
        "page_count": None,
        "converted_markdown": [str(src)],
    }

    result = await _compute_ai_page_count(state)
    assert result["page_count"] == 3
    assert "fell back" in result["page_count_reasoning"].lower() or "fallback" in result["page_count_reasoning"].lower()


@pytest.mark.asyncio
async def test_llm_garbage_and_no_markers_uses_heuristic(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """No page markers, no parsable LLM output → heuristic fallback."""
    src = tmp_path / "src.md"
    # A medium-sized source with 5 top-level sections, no page markers
    src.write_text(
        "\n".join(f"# Section {i}\n\n" + "Lorem ipsum dolor sit amet. " * 200 for i in range(1, 6)),
        encoding="utf-8",
    )

    fake = FakeJsonModel("not json at all")

    async def _fake_get_chat_model(role):
        return fake

    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_chat_model",
        _fake_get_chat_model,
    )

    state = {
        "page_count_mode": "ai_decide",
        "page_count": None,
        "converted_markdown": [str(src)],
    }

    result = await _compute_ai_page_count(state)
    assert 5 <= result["page_count"] <= 30
    assert "heuristic" in result["page_count_reasoning"].lower()
