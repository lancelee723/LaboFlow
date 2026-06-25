"""Tests for parsing image_gen.py --list-backends --json output."""
import json
import subprocess
from pathlib import Path

import pytest

from pptmaster.config import get_settings


def _scripts_dir() -> str:
    """Return the ppt-master scripts dir, preferring the env-configured path."""
    configured = get_settings().pptmaster_scripts_dir
    # If the configured path exists, use it (production / CI with .env loaded).
    if Path(configured).is_dir():
        return configured
    # Fallback: resolve relative to this test file for local dev runs where
    # .env is not on the pytest search path.
    fallback = (
        Path(__file__).resolve().parents[4]
        / "ppt-master"
        / "skills"
        / "ppt-master"
        / "scripts"
    )
    if fallback.is_dir():
        return str(fallback)
    pytest.skip(f"scripts dir not found (tried {configured} and {fallback})")


def test_list_backends_json_returns_array():
    scripts_dir = _scripts_dir()
    result = subprocess.run(
        ["python3", f"{scripts_dir}/image_gen.py", "--list-backends", "--json"],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert isinstance(payload, list)
    assert len(payload) >= 5
    sample = payload[0]
    for key in ("name", "label", "tier", "default_model", "key_hint"):
        assert key in sample


def test_list_backends_json_includes_gemini():
    scripts_dir = _scripts_dir()
    result = subprocess.run(
        ["python3", f"{scripts_dir}/image_gen.py", "--list-backends", "--json"],
        capture_output=True, text=True, timeout=10,
    )
    payload = json.loads(result.stdout)
    names = [b["name"] for b in payload]
    assert "gemini" in names
