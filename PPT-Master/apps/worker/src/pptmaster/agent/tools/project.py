"""Project management tools (Step 2)."""

import json
import os
from pathlib import Path

from .source import run_script


async def project_manager_init(name: str, base_dir: str = "projects", format: str = "ppt169") -> dict:
    """Initialize a new PPT-Master project directory structure.

    Args:
        name: Project name (sanitized to filesystem-safe)
        base_dir: Parent directory for projects (default 'projects')
        format: Canvas format (ppt169, ppt43, a4l, a4p, etc.)
    """
    result = await run_script("project_manager.py", "init", name, "--format", format, "--dir", base_dir, cwd=base_dir)
    return result


async def project_manager_import_sources(project_path: str, *sources: str, move: bool = True) -> dict:
    """Import source files into a project.

    Args:
        project_path: Path to the project directory
        sources: Source file paths to import
        move: If True, move files. If False, copy.
    """
    args = ["project_manager.py", "import-sources", project_path, *sources]
    if move:
        args.append("--move")
    else:
        args.append("--copy")
    return await run_script(*args, cwd=project_path)


async def project_manager_validate(project_path: str) -> dict:
    """Validate project structure integrity."""
    return await run_script("project_manager.py", "validate", project_path, cwd=project_path)


async def project_manager_info(project_path: str) -> dict:
    """Get project information (sources, step status, artifacts)."""
    return await run_script("project_manager.py", "info", project_path, cwd=project_path)
