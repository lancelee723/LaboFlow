"""Thin wrapper around the PPT-Master skill's svg_to_pptx/pptx_cli.py for in-graph use."""
import os
import sys
from pathlib import Path

# See total_md_split.py for the rationale (env-var first, guarded dev fallback).
_PARENTS = Path(__file__).resolve().parents
_DEV_DEFAULT = (
    str(_PARENTS[5].parent / "ppt-master" / "skills" / "ppt-master" / "scripts")
    if len(_PARENTS) > 5 else "/opt/pptmaster-skill/scripts"
)
_SKILL_SCRIPTS = Path(os.environ.get("PPTMASTER_SCRIPTS_DIR") or _DEV_DEFAULT)


def run(project_path: Path) -> None:
    _ensure_on_path()
    from svg_to_pptx.pptx_cli import main as _export_main  # type: ignore[import-untyped]

    old_argv = sys.argv
    try:
        sys.argv = ["svg_to_pptx.py", str(project_path), "--only", "legacy", "-o", f"{project_path}/exports/output.pptx"]
        try:
            _export_main()
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 0 if e.code is None else 1
            if code != 0:
                raise RuntimeError(f"svg_to_pptx exited with code {code}") from e
    finally:
        sys.argv = old_argv

    # pptx_cli adds an "_svg" suffix to legacy outputs even when -o is given.
    # Rename it to the canonical path the coordinator + FE expect.
    exports_dir = project_path / "exports"
    legacy_pptx = exports_dir / "output_svg.pptx"
    canonical_pptx = exports_dir / "output.pptx"
    if legacy_pptx.is_file() and not canonical_pptx.is_file():
        legacy_pptx.rename(canonical_pptx)


def _ensure_on_path() -> None:
    if str(_SKILL_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SKILL_SCRIPTS))
