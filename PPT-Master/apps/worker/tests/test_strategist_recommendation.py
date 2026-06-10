"""Tests for _extract_recommendation — G1.1."""
import pytest

from pptmaster.agent.strategist import _extract_recommendation


def test_valid_block_extracts_cleanly():
    content = 'Some analysis here.\n<<RECOMMENDATION>>{"format": "ppt169"}<<END>>\nMore text.'
    cleaned, rec = _extract_recommendation(content)
    assert rec == {"format": "ppt169"}
    assert "<<RECOMMENDATION>>" not in cleaned
    assert "<<END>>" not in cleaned
    assert "Some analysis here." in cleaned
    assert "More text." in cleaned


def test_valid_block_complex_json():
    content = (
        "Here is my reasoning.\n"
        '<<RECOMMENDATION>>{"count": 12, "mode": "explicit"}<<END>>'
    )
    cleaned, rec = _extract_recommendation(content)
    assert rec == {"count": 12, "mode": "explicit"}
    assert "<<RECOMMENDATION>>" not in cleaned
    assert cleaned.strip() == "Here is my reasoning."


def test_no_block_returns_original_and_none():
    content = "No block here at all. Just plain text."
    cleaned, rec = _extract_recommendation(content)
    assert rec is None
    assert cleaned == content


def test_invalid_json_inside_block_returns_original_and_none():
    content = "Preamble. <<RECOMMENDATION>>not valid json at all<<END>> Postamble."
    cleaned, rec = _extract_recommendation(content)
    assert rec is None
    assert cleaned == content


def test_multiline_json_block_extracts():
    """DOTALL flag should handle newlines inside the block."""
    content = (
        "Analysis.\n"
        "<<RECOMMENDATION>>{\n"
        '  "primary": "#1A365D",\n'
        '  "accent": "#E53E3E"\n'
        "}<<END>>\nDone."
    )
    cleaned, rec = _extract_recommendation(content)
    assert rec == {"primary": "#1A365D", "accent": "#E53E3E"}
    assert "<<RECOMMENDATION>>" not in cleaned


def test_empty_string_input():
    cleaned, rec = _extract_recommendation("")
    assert rec is None
    assert cleaned == ""


def test_missing_end_tag_returns_original_and_none():
    """If <<END>> is absent, regex won't match; return original + None."""
    content = "Preamble. <<RECOMMENDATION>>{\"k\": 1} no end tag"
    cleaned, rec = _extract_recommendation(content)
    assert rec is None
    assert cleaned == content
