"""Tests for bootstrap's filesystem scanner."""

import json
from pathlib import Path

from pptmaster.bootstrap import _scan_skill_templates


def test_scan_empty_root(tmp_path: Path):
    """Missing index files → empty list, no exceptions."""
    rows = _scan_skill_templates(tmp_path)
    assert rows == []


def test_scan_returns_layouts_from_index(tmp_path: Path):
    """layouts_index.json drives layout discovery; SVGs become preview_paths."""
    layouts_dir = tmp_path / "layouts"
    layouts_dir.mkdir()
    (layouts_dir / "layouts_index.json").write_text(json.dumps({
        "test_layout": {
            "summary": "A test layout",
            "canvas_format": "ppt169",
            "page_count": 2,
            "page_types": ["cover", "content"],
        }
    }))
    test_layout = layouts_dir / "test_layout"
    test_layout.mkdir()
    (test_layout / "01_cover.svg").write_text("<svg/>")
    (test_layout / "02_content.svg").write_text("<svg/>")

    rows = _scan_skill_templates(tmp_path)

    assert len(rows) == 1
    row = rows[0]
    assert row["template_id"] == "test_layout"
    assert row["kind"] == "layout"
    assert row["uploaded_by"] is None
    assert row["name"] == "Test Layout"
    assert row["summary"] == "A test layout"
    assert row["canvas_format"] == "ppt169"
    assert row["page_count"] == 2
    assert row["page_types"] == ["cover", "content"]
    assert row["preview_paths"] == ["01_cover.svg", "02_content.svg"]
    assert row["storage_path"] == str(test_layout)


def test_scan_returns_brands_from_index(tmp_path: Path):
    """brands_index.json drives brand discovery."""
    brands_dir = tmp_path / "brands"
    brands_dir.mkdir()
    (brands_dir / "brands_index.json").write_text(json.dumps({
        "acme": {
            "summary": "Acme brand",
            "primary_color": "#FF0000",
        }
    }))
    acme = brands_dir / "acme"
    acme.mkdir()
    (acme / "logo.svg").write_text("<svg/>")

    rows = _scan_skill_templates(tmp_path)

    assert len(rows) == 1
    row = rows[0]
    assert row["template_id"] == "acme"
    assert row["kind"] == "brand"
    assert row["primary_color"] == "#FF0000"
    assert row["canvas_format"] == "brand"
    assert row["preview_paths"] == ["logo.svg"]


def test_scan_returns_decks_from_subdirs(tmp_path: Path):
    """Each decks/ subdir with at least one SVG becomes a deck template."""
    decks_dir = tmp_path / "decks"
    decks_dir.mkdir()
    deck = decks_dir / "sample_deck"
    deck.mkdir()
    (deck / "01.svg").write_text("<svg/>")
    empty_deck = decks_dir / "empty_deck"
    empty_deck.mkdir()  # no SVG, should be skipped

    rows = _scan_skill_templates(tmp_path)

    assert len(rows) == 1
    assert rows[0]["template_id"] == "sample_deck"
    assert rows[0]["kind"] == "deck"


def test_scan_skips_layouts_without_dir(tmp_path: Path):
    """Index entries with no matching dir are skipped silently."""
    layouts_dir = tmp_path / "layouts"
    layouts_dir.mkdir()
    (layouts_dir / "layouts_index.json").write_text(json.dumps({
        "ghost_layout": {"summary": "x", "canvas_format": "ppt169"},
    }))
    # No ghost_layout/ dir created

    rows = _scan_skill_templates(tmp_path)
    assert rows == []


def test_scan_real_ppt_master_repo():
    """Smoke test against the real ppt-master skill templates dir."""
    real_root = Path("/Users/lance/AI/Skills/ppt-master/skills/ppt-master/templates")
    if not real_root.is_dir():
        import pytest
        pytest.skip("Real ppt-master repo not available in this environment")

    rows = _scan_skill_templates(real_root)
    template_ids = {r["template_id"] for r in rows}

    expected_layouts = {
        "academic_defense", "ai_ops", "government_blue", "government_red",
        "medical_university", "pixel_retro", "psychology_attachment",
    }
    expected_brands = {"anthropic", "google"}

    assert expected_layouts.issubset(template_ids), f"Missing layouts: {expected_layouts - template_ids}"
    assert expected_brands.issubset(template_ids), f"Missing brands: {expected_brands - template_ids}"
