"""Thin wrapper around the PPT-Master skill's total_md_split.py for in-graph use."""
import os
import sys
from pathlib import Path

# Container deploys set PPTMASTER_SCRIPTS_DIR (Dockerfile.worker ENV). Dev mode
# expects the skill repo to sit beside this monorepo at <ws>/ppt-master/skills/...
# parents[5] only resolves to a real repo root when the dev layout has enough depth,
# so guard against shorter paths (container layout: /app/src/pptmaster/scripts/...)
# which would otherwise raise IndexError at import time.
_PARENTS = Path(__file__).resolve().parents
_DEV_DEFAULT = (
    str(_PARENTS[5].parent / "ppt-master" / "skills" / "ppt-master" / "scripts")
    if len(_PARENTS) > 5 else "/opt/pptmaster-skill/scripts"
)
_SKILL_SCRIPTS = Path(os.environ.get("PPTMASTER_SCRIPTS_DIR") or _DEV_DEFAULT)


def run(project_path: Path) -> None:
    _ensure_on_path()
    from total_md_split import main as _split_main  # type: ignore[import-untyped]

    old_argv = sys.argv
    try:
        sys.argv = ["total_md_split.py", str(project_path)]
        try:
            _split_main()
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 0 if e.code is None else 1
            if code != 0:
                raise RuntimeError(f"total_md_split exited with code {code}") from e
    finally:
        sys.argv = old_argv


def _ensure_on_path() -> None:
    if str(_SKILL_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SKILL_SCRIPTS))
