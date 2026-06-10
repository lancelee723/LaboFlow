"""Tests for template wizard backend (G3)."""

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from pptmaster.api._template_wizard import (
    DECK_FIELDS,
    LAYOUT_FIELDS,
    BRAND_FIELDS,
    auto_detect_kind,
    build_template_designer_prompt,
    extract_manifest_fields,
    parse_design_spec_from_llm_response,
    parse_svg_pages_from_llm_response,
    save_template_assets,
)


# ── Field schemas ──────────────────────────────────────────────────────────

def test_deck_fields_includes_identity_and_structure():
    assert "template_id" in DECK_FIELDS
    assert "primary_color" in DECK_FIELDS
    assert "page_count" in DECK_FIELDS
    assert "canvas_format" in DECK_FIELDS
    assert "colors" in DECK_FIELDS
    assert "typography" in DECK_FIELDS
    assert "image_strategy" in DECK_FIELDS


def test_layout_fields_excludes_identity():
    assert "template_id" in LAYOUT_FIELDS
    assert "primary_color" not in LAYOUT_FIELDS
    assert "colors" not in LAYOUT_FIELDS
    assert "typography" not in LAYOUT_FIELDS
    assert "page_types" in LAYOUT_FIELDS


def test_brand_fields_excludes_structure():
    assert "template_id" in BRAND_FIELDS
    assert "primary_color" in BRAND_FIELDS
    assert "colors" in BRAND_FIELDS
    assert "typography" in BRAND_FIELDS
    assert "page_types" not in BRAND_FIELDS
    assert "canvas_format" not in BRAND_FIELDS


# ── Manifest field extraction ──────────────────────────────────────────────

MINIMAL_MANIFEST = {
    "slideSize": {"width": 12192000, "height": 6858000},
    "theme": {
        "name": "Office Theme",
        "colors": {
            "dk1": "#000000",
            "lt1": "#FFFFFF",
            "dk2": "#44546A",
            "lt2": "#E7E6E6",
            "accent1": "#4472C4",
        },
        "fonts": {
            "title": "Calibri",
            "body": "Calibri",
            "bodySize": "18pt",
        },
    },
    "slides": [{"id": 1, "name": "Slide 1"}, {"id": 2, "name": "Slide 2"}],
    "layouts": [
        {"name": "Title Slide"},
        {"name": "Content"},
        {"name": "Blank"},
    ],
    "assets": {"allAssets": [], "commonAssets": []},
}


def test_extract_manifest_fields_deck():
    fields = extract_manifest_fields(MINIMAL_MANIFEST, "deck")
    assert "canvas_format" in fields
    assert fields["canvas_format"]["value"] == "ppt169"
    assert "primary_color" in fields
    assert fields["primary_color"]["value"] == "#4472C4"
    assert fields["page_count"]["value"] == 2
    assert "colors" in fields
    assert fields["colors"]["value"]["accent1"] == "#4472C4"
    assert "image_strategy" in fields  # deck-only
    assert "voice_tone" in fields  # deck-only


def test_extract_manifest_fields_layout():
    fields = extract_manifest_fields(MINIMAL_MANIFEST, "layout")
    assert "canvas_format" in fields
    assert "page_count" in fields
    assert "page_types" in fields
    # Layout excludes identity fields
    assert "primary_color" not in fields
    assert "colors" not in fields
    assert "typography" not in fields


def test_extract_manifest_fields_brand():
    fields = extract_manifest_fields(MINIMAL_MANIFEST, "brand")
    assert "primary_color" in fields
    assert "colors" in fields
    # Brand excludes structure fields
    assert "canvas_format" not in fields
    assert "page_count" not in fields
    assert "page_types" not in fields


def test_extract_manifest_fields_43_format():
    manifest = {**MINIMAL_MANIFEST, "slideSize": {"width": 9144000, "height": 6858000}}
    fields = extract_manifest_fields(manifest, "deck")
    assert fields["canvas_format"]["value"] == "ppt43"


# ── Auto-detect kind ───────────────────────────────────────────────────────

def test_auto_detect_kind_deck_with_branding():
    manifest = {
        "theme": {"colors": {"accent1": "#FF0000", "dk1": "#000", "lt1": "#FFF"}, "fonts": {"title": "Noto Sans"}},
        "assets": {"allAssets": [{"name": "logo.png"}], "commonAssets": []},
        "slides": [{"id": 1}, {"id": 2}, {"id": 3}],
        "layouts": [{"name": "Title"}, {"name": "Content"}],
    }
    assert auto_detect_kind(manifest) == "deck"


def test_auto_detect_kind_layout_no_colors():
    manifest = {
        "theme": {"colors": {}, "fonts": {}},
        "assets": {"allAssets": [], "commonAssets": []},
        "slides": [{"id": 1}, {"id": 2}, {"id": 3}],
        "layouts": [{"name": "Content"}, {"name": "Blank"}],
    }
    assert auto_detect_kind(manifest) == "layout"


def test_auto_detect_kind_brand_no_structure():
    manifest = {
        "theme": {"colors": {"accent1": "#FF0000", "dk1": "#000"}, "fonts": {"title": "CustomFont"}},
        "assets": {"allAssets": [{"name": "brand_logo.png"}], "commonAssets": []},
        "slides": [{"id": 1}],
        "layouts": [],
    }
    assert auto_detect_kind(manifest) == "brand"


# ── Prompt building ─────────────────────────────────────────────────────────

def test_build_template_designer_prompt_deck():
    fields = {"template_id": "test_deck", "name": "Test Deck", "summary": "A test", "canvas_format": "ppt169"}
    prompt = build_template_designer_prompt("deck", fields)
    assert "Template_Designer" in prompt
    assert "test_deck" in prompt
    assert "Test Deck" in prompt
    assert "01_cover" in prompt
    assert "III. Color Scheme" in prompt
    assert "VIII. Voice & Tone" in prompt


def test_build_template_designer_prompt_layout():
    fields = {"template_id": "test_layout", "name": "Test Layout", "summary": "A test", "canvas_format": "ppt43"}
    prompt = build_template_designer_prompt("layout", fields)
    assert "test_layout" in prompt
    assert "Layout 模板不包含颜色方案" in prompt or "不包含" in prompt
    assert "Color Scheme" not in prompt or "color scheme" not in prompt.lower().split("iii")[-1] if "iii" in prompt.lower() else True


def test_build_template_designer_prompt_brand():
    fields = {"template_id": "test_brand", "name": "Test Brand", "summary": "A test", "primary_color": "#FF0000"}
    prompt = build_template_designer_prompt("brand", fields)
    assert "test_brand" in prompt
    assert "只生成 design_spec.md" in prompt
    assert "Brand Overview" in prompt or "Brand 概述" in prompt or "I. Brand" in prompt


# ── SVG parsing ────────────────────────────────────────────────────────────

def test_parse_svg_pages_from_code_blocks():
    response = """```yaml
---
kind: deck
---
```

## Page Roster

```svg
<!-- 01_cover.svg -->
<svg viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#4472C4"/>
  <text x="100" y="100">Cover</text>
</svg>
```

```svg
<!-- 03_content.svg -->
<svg viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#FFFFFF"/>
  <text x="100" y="100">Content</text>
</svg>
```"""
    pages = parse_svg_pages_from_llm_response(response)
    assert len(pages) == 2
    filenames = [p["filename"] for p in pages]
    assert "01_cover.svg" in filenames
    assert "03_content.svg" in filenames
    for p in pages:
        assert p["content"].startswith("<svg")
        assert p["content"].endswith("</svg>")


def test_parse_svg_pages_bare_svg():
    response = """---
kind: layout
---

Some text.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <rect width="960" height="540"/>
</svg>

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <rect width="960" height="540"/>
</svg>"""
    pages = parse_svg_pages_from_llm_response(response)
    assert len(pages) == 2


def test_parse_design_spec_removes_svg_blocks():
    response = """```yaml
---
kind: deck
name: Test
---
```

## Overview

```svg
<svg>test</svg>
```"""
    spec = parse_design_spec_from_llm_response(response)
    assert "```svg" not in spec
    assert "<svg" not in spec
    assert "## Overview" in spec


# ── Asset saving ───────────────────────────────────────────────────────────

def test_save_template_assets_writes_files(tmp_path: Path):
    design_spec = "---\nkind: deck\n---\n\n# Test\n"
    svg_pages = [
        {"filename": "01_cover.svg", "content": "<svg><rect/></svg>"},
        {"filename": "03_content.svg", "content": "<svg><circle/></svg>"},
    ]
    target = tmp_path / "test_deck"

    save_template_assets("deck", "test_deck", design_spec, svg_pages, target)

    assert (target / "design_spec.md").read_text() == design_spec
    assert (target / "01_cover.svg").read_text() == "<svg><rect/></svg>"
    assert (target / "03_content.svg").read_text() == "<svg><circle/></svg>"
    # Deck creates svg_final/ too
    assert (target / "svg_final" / "01_cover.svg").exists()
    assert (target / "svg_final" / "03_content.svg").exists()


def test_save_template_assets_brand_no_svg(tmp_path: Path):
    design_spec = "---\nkind: brand\n---\n\n# Brand\n"
    target = tmp_path / "test_brand"

    save_template_assets("brand", "test_brand", design_spec, [], target)

    assert (target / "design_spec.md").exists()
    # No svg_final for brand
    assert not (target / "svg_final").exists()
