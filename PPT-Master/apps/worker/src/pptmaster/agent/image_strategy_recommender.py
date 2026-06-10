"""Helpers that load the rendering / palette index summaries for Strategist
Gate 8.

Index files are intentionally short (~50 lines) — they exist so Strategist
can pick a rendering and palette without reading the full per-style file.
"""

from pathlib import Path

from pptmaster.config import get_settings


def _references_root() -> str:
    return get_settings().pptmaster_references_dir


def _read_index(relative_path: str) -> str:
    full = Path(_references_root()) / relative_path
    if not full.is_file():
        return ""
    try:
        text = full.read_text(encoding="utf-8")
    except OSError:
        return ""
    # Hard cap to keep prompt budget predictable
    return text[:4000]


def load_rendering_index_summary() -> str:
    return _read_index("image-renderings/_index.md")


def load_palette_index_summary() -> str:
    return _read_index("image-palettes/_index.md")
