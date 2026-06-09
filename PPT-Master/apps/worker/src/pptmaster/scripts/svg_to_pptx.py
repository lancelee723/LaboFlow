"""Thin wrapper around the PPT-Master skill's svg_to_pptx/pptx_cli.py for in-graph use."""
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[5]  # apps/worker/src/pptmaster/scripts/ -> repo root
_SKILL_SCRIPTS = _REPO_ROOT.parent / "ppt-master" / "skills" / "ppt-master" / "scripts"


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
