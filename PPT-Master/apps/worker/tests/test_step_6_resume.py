"""Verify step_6_executor skips pages with pre-existing valid SVG files."""
import pytest
from pathlib import Path


def test_file_exists_check_reuses_valid_svg(tmp_path: Path):
    """SVG file with valid content -> should be reused, not regenerated."""
    svg_dir = tmp_path / "svg_output"
    svg_dir.mkdir()
    existing_svg = svg_dir / "01_cover.svg"
    # Write valid SVG content with enough size to pass the 200-byte threshold
    existing_svg.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">'
        '<rect width="100%" height="100%" fill="#fff"/>'
        '</svg>',
        encoding="utf-8",
    )
    # Pad to exceed 200 bytes
    existing_svg.write_text(existing_svg.read_text() + " " * 500, encoding="utf-8")

    from pptmaster.agent.coordinator import _svg_is_valid
    assert _svg_is_valid(existing_svg) is True


def test_file_exists_check_rejects_corrupt_svg(tmp_path: Path):
    """SVG file too small or missing closing tag -> should be regenerated."""
    svg_dir = tmp_path / "svg_output"
    svg_dir.mkdir()

    from pptmaster.agent.coordinator import _svg_is_valid

    # Too small
    tiny = svg_dir / "tiny.svg"
    tiny.write_text("<svg></svg>", encoding="utf-8")
    assert _svg_is_valid(tiny) is False

    # Missing closing tag
    incomplete = svg_dir / "incomplete.svg"
    incomplete.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<rect width="100" height="100"/>' * 20,
        encoding="utf-8",
    )
    assert _svg_is_valid(incomplete) is False, "SVG without </svg> should be treated as corrupt"


def test_file_not_exists_rejected(tmp_path: Path):
    """Non-existent file -> not valid."""
    from pptmaster.agent.coordinator import _svg_is_valid
    assert _svg_is_valid(tmp_path / "nonexistent.svg") is False
