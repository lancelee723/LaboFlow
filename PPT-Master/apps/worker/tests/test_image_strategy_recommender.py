"""Tests for image strategy recommender helpers."""
from pptmaster.agent.image_strategy_recommender import (
    load_rendering_index_summary,
    load_palette_index_summary,
)


def test_load_rendering_index_returns_short_summary(monkeypatch, tmp_path):
    refs = tmp_path
    (refs / "image-renderings").mkdir()
    (refs / "image-renderings" / "_index.md").write_text(
        "# Rendering Index\n"
        "\n"
        "| Name | Description |\n"
        "|---|---|\n"
        "| vector-illustration | Flat vector style |\n"
        "| corporate-photo | Editorial photography |\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "pptmaster.agent.image_strategy_recommender._references_root",
        lambda: str(refs),
    )
    text = load_rendering_index_summary()
    assert "vector-illustration" in text
    assert "corporate-photo" in text
    # Should be under 2000 chars to fit in LLM prompt comfortably
    assert len(text) < 2000


def test_load_palette_index_returns_short_summary(monkeypatch, tmp_path):
    refs = tmp_path
    (refs / "image-palettes").mkdir()
    (refs / "image-palettes" / "_index.md").write_text(
        "# Palette Index\n\n- cool-corporate\n- warm-tech\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "pptmaster.agent.image_strategy_recommender._references_root",
        lambda: str(refs),
    )
    text = load_palette_index_summary()
    assert "cool-corporate" in text
    assert "warm-tech" in text


def test_load_index_missing_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "pptmaster.agent.image_strategy_recommender._references_root",
        lambda: str(tmp_path),
    )
    assert load_rendering_index_summary() == ""
    assert load_palette_index_summary() == ""
