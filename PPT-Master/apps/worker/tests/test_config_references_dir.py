"""Tests for pptmaster_references_dir derivation."""
from pathlib import Path

from pptmaster.config import get_settings


def test_references_dir_is_siblings_of_scripts():
    s = get_settings()
    expected = Path(s.pptmaster_scripts_dir).parent / "references"
    assert Path(s.pptmaster_references_dir) == expected
