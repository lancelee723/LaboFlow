"""Unit tests for per-page SVG annotation utilities."""

import xml.etree.ElementTree as ET

from pptmaster.agent.annotations import (
    build_regeneration_prompt,
    parse_annotations,
    set_annotation,
    strip_transient_ids,
)

# ── set_annotation ───────────────────────────────────────────────────────────


def test_set_annotation_adds_correct_attributes() -> None:
    root = ET.fromstring('<svg><text id="myId">Hello</text></svg>')
    ok = set_annotation(root, "myId", "change this text")
    assert ok

    elem = root.find('.//text')
    assert elem is not None
    assert elem.get("data-edit-target") == "text"
    assert elem.get("data-edit-annotation") == "change this text"


def test_set_annotation_returns_false_for_missing_id() -> None:
    root = ET.fromstring('<svg><text>No id</text></svg>')
    ok = set_annotation(root, "nonexistent", "nope")
    assert not ok


def test_set_annotation_handles_svg_namespace() -> None:
    """Attributes set on namespace-qualified elements should still be found."""
    root = ET.fromstring(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<rect id="box1" x="0" y="0"/>'
        "</svg>"
    )
    ok = set_annotation(root, "box1", "make it red")
    assert ok

    # The id lookup is namespace-agnostic — attributes don't carry ns.
    for elem in root.iter():
        if elem.get("id") == "box1":
            assert elem.get("data-edit-target") == "rect"
            assert elem.get("data-edit-annotation") == "make it red"
            return
    raise AssertionError("Annotated element not found by id")


def test_set_annotation_targets_first_match_only() -> None:
    root = ET.fromstring(
        '<svg>'
        '<text id="dup">First</text>'
        '<text id="dup">Second</text>'
        "</svg>"
    )
    ok = set_annotation(root, "dup", "collision")
    assert ok

    found = 0
    for elem in root.iter():
        if elem.get("data-edit-annotation") == "collision":
            found += 1
    assert found == 1, "Only the first element with matching id should be annotated"


# ── strip_transient_ids ──────────────────────────────────────────────────────


def test_strip_transient_ids_removes_unused_edit_ids() -> None:
    root = ET.fromstring(
        '<svg>'
        '<text id="_edit_1">Keep me</text>'
        '<rect id="_edit_2">Drop me</rect>'
        '<circle id="stable">Stay</circle>'
        "</svg>"
    )
    strip_transient_ids(root, {"_edit_1"})

    ids = {elem.get("id") for elem in root.iter() if elem.get("id")}
    assert ids == {"_edit_1", "stable"}


def test_strip_transient_ids_ignores_non_edit_ids() -> None:
    root = ET.fromstring(
        '<svg>'
        '<text id="slide_title">Title</text>'
        '<rect id="_edit_3">X</rect>'
        '<circle id="_edit_4">Y</circle>'
        "</svg>"
    )
    strip_transient_ids(root, set())  # no annotated ids

    ids = {elem.get("id") for elem in root.iter() if elem.get("id")}
    assert ids == {"slide_title"}


# ── parse_annotations ────────────────────────────────────────────────────────


def test_parse_annotations_extracts_data_edit_pairs() -> None:
    root = ET.fromstring(
        '<svg>'
        '<text id="a1" data-edit-annotation="change color">Hello</text>'
        '<rect id="a2" data-edit-annotation="resize">Box</rect>'
        '<circle id="no_ann">Plain</circle>'
        "</svg>"
    )
    result = parse_annotations(root)
    assert result == {"a1": "change color", "a2": "resize"}


def test_parse_annotations_skips_elements_without_id() -> None:
    root = ET.fromstring(
        '<svg>'
        '<text data-edit-annotation="orphan">No id</text>'
        '<rect id="ok" data-edit-annotation="valid">Yes</rect>'
        "</svg>"
    )
    result = parse_annotations(root)
    assert result == {"ok": "valid"}


def test_parse_annotations_empty_when_none_present() -> None:
    root = ET.fromstring('<svg><text id="t">Clean</text></svg>')
    result = parse_annotations(root)
    assert result == {}


# ── build_regeneration_prompt ────────────────────────────────────────────────


def test_build_regeneration_prompt_includes_page_context() -> None:
    svg = '<svg><text id="e1">Revenue grew 20%</text></svg>'
    annotations = {"e1": "make it say 30%"}
    prompt = build_regeneration_prompt(3, 10, "Financials", svg, annotations)

    assert 'Page 3/10: "Financials"' in prompt
    assert "Current SVG content:" in prompt
    assert svg in prompt
    assert 'Element "e1"' in prompt
    assert 'User annotation: "make it say 30%"' in prompt
    assert "Regenerate this page's SVG" in prompt
    assert "Return ONLY the complete modified SVG" in prompt


def test_build_regeneration_prompt_handles_multiple_annotations() -> None:
    svg = (
        '<svg>'
        '<text id="e1">Old title</text>'
        '<rect id="e2">Blue box</rect>'
        "</svg>"
    )
    annotations = {"e1": "change to New title", "e2": "make green"}
    prompt = build_regeneration_prompt(1, 5, "Cover", svg, annotations)

    # Both annotations appear
    assert 'Element "e1"' in prompt
    assert 'Element "e2"' in prompt
    assert 'User annotation: "change to New title"' in prompt
    assert 'User annotation: "make green"' in prompt


def test_build_regeneration_prompt_extracts_element_text_from_svg() -> None:
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><text id="e1" fill="red">Sales Chart</text></svg>'
    annotations = {"e1": "add subtitle"}
    prompt = build_regeneration_prompt(2, 8, "Analytics", svg, annotations)

    # Should have extracted "Sales Chart" as the element text
    assert 'text content: "Sales Chart"' in prompt
