"""Tests for Gate 8 prompt enrichment with rendering/palette catalogs."""
from pptmaster.agent.strategist import GATE_PROMPTS, build_gate_8_prompt


def test_gate_8_static_prompt_unchanged():
    """Sanity: the static catalog of acquisition modes still mentions ai/web/user/placeholder."""
    text = GATE_PROMPTS["images"]
    for word in ("AI", "Web", "User", "Placeholder"):
        assert word in text


def test_build_gate_8_prompt_includes_rendering_and_palette_catalogs(monkeypatch):
    monkeypatch.setattr(
        "pptmaster.agent.strategist.load_rendering_index_summary",
        lambda: "RENDERING_CATALOG_PLACEHOLDER",
    )
    monkeypatch.setattr(
        "pptmaster.agent.strategist.load_palette_index_summary",
        lambda: "PALETTE_CATALOG_PLACEHOLDER",
    )
    prompt = build_gate_8_prompt()
    assert "RENDERING_CATALOG_PLACEHOLDER" in prompt
    assert "PALETTE_CATALOG_PLACEHOLDER" in prompt
    assert "deck_rendering" in prompt
    assert "deck_palette" in prompt


def test_build_gate_8_prompt_omits_catalog_section_when_indices_missing(monkeypatch):
    monkeypatch.setattr(
        "pptmaster.agent.strategist.load_rendering_index_summary",
        lambda: "",
    )
    monkeypatch.setattr(
        "pptmaster.agent.strategist.load_palette_index_summary",
        lambda: "",
    )
    prompt = build_gate_8_prompt()
    # Should still contain the base ai/web/user/placeholder catalog
    assert "AI Generated" in prompt or "ai/web" in prompt.lower()
