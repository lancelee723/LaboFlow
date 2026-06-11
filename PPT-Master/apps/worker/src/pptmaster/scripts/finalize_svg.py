"""Thin wrapper around the PPT-Master skill's finalize_svg.py for in-graph use."""
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
    from finalize_svg import main as _finalize_main  # type: ignore[import-untyped]

    old_argv = sys.argv
    try:
        sys.argv = ["finalize_svg.py", str(project_path)]
        try:
            _finalize_main()
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 0 if e.code is None else 1
            if code != 0:
                raise RuntimeError(f"finalize_svg exited with code {code}") from e
    finally:
        sys.argv = old_argv


def _ensure_on_path() -> None:
    if str(_SKILL_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SKILL_SCRIPTS))
