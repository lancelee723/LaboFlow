"""Tests that _strategist_finalize emits deck_rendering / deck_palette."""
from pptmaster.agent.strategist import _write_spec_lock_images


def test_write_spec_lock_images_includes_deck_fields():
    rec = {
        "strategy": "ai_generated",
        "deck_rendering": "corporate-photo",
        "deck_palette": "warm-tech",
        "count": 5,
    }
    output = _write_spec_lock_images(rec)
    assert "strategy: ai_generated" in output
    assert "deck_rendering: corporate-photo" in output
    assert "deck_palette: warm-tech" in output


def test_write_spec_lock_images_omits_deck_fields_when_missing():
    rec = {"strategy": "ai_generated"}
    output = _write_spec_lock_images(rec)
    assert "strategy: ai_generated" in output
    assert "deck_rendering" not in output
    assert "deck_palette" not in output
