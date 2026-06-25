"""Template selection tools (Step 3) and PPTX import subprocess wrapper."""

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from pptmaster.config import get_settings


def _templates_dir() -> str:
    return get_settings().pptmaster_templates_dir


def list_layouts() -> dict[str, Any]:
    """List all available layout templates with summaries.

    Returns layout_id -> {summary, canvas_format, page_count, page_types}.
    """
    index_path = Path(_templates_dir()) / "layouts" / "layouts_index.json"
    if not index_path.exists():
        return {"success": False, "error": f"Layouts index not found: {index_path}"}

    with open(index_path) as f:
        data = json.load(f)

    return {"success": True, "layouts": data, "count": len(data)}


def list_brands() -> dict[str, Any]:
    """List all available brand presets."""
    brands_dir = Path(_templates_dir()) / "brands"
    index_path = brands_dir / "brands_index.json"

    if index_path.exists():
        with open(index_path) as f:
            data = json.load(f)
    else:
        data = {}
        for d in brands_dir.iterdir():
            if d.is_dir() and not d.name.startswith("."):
                meta_path = d / "meta.json"
                if meta_path.exists():
                    with open(meta_path) as f:
                        data[d.name] = json.load(f)
                else:
                    data[d.name] = {"name": d.name}

    return {"success": True, "brands": data, "count": len(data)}


def list_charts() -> dict[str, Any]:
    """List available chart template categories."""
    charts_dir = Path(_templates_dir()) / "charts"
    if not charts_dir.exists():
        return {"success": True, "charts": {}, "count": 0}

    cats = {}
    for d in charts_dir.iterdir():
        if d.is_dir() and not d.name.startswith("."):
            svgs = list(d.glob("*.svg"))
            cats[d.name] = {"path": str(d), "charts": [s.stem for s in svgs]}

    return {"success": True, "charts": cats, "count": len(cats)}


def list_icons() -> dict[str, Any]:
    """List available icon sets."""
    icons_dir = Path(_templates_dir()) / "icons"
    if not icons_dir.exists():
        return {"success": True, "icons": {}, "count": 0}

    sets = {}
    for d in icons_dir.iterdir():
        if d.is_dir() and not d.name.startswith(".") and not d.name.startswith("__"):
            svgs = list(d.glob("*.svg"))
            if svgs:
                sets[d.name] = {"count": len(svgs)}

    return {"success": True, "icons": sets, "count": len(sets)}


def read_template_spec(template_id: str) -> dict[str, Any]:
    """Read a template's design_spec.md and spec_lock.md."""
    layouts_dir = Path(_templates_dir()) / "layouts" / template_id
    if not layouts_dir.exists():
        return {"success": False, "error": f"Template not found: {template_id}"}

    result = {}
    for name in ["design_spec.md", "spec_lock.md", "README.md"]:
        path = layouts_dir / name
        if path.exists():
            result[name.replace(".", "_")] = path.read_text()[:5000]

    return {"success": True, "template_id": template_id, **result}


# ── Subprocess wrappers for the template wizard ───────────────────────────


_RESOLVED_SCRIPTS_DIR: str | None = None


def _resolve_scripts_dir() -> str:
    """Resolve the ppt-master scripts directory from config or repo-relative path."""
    global _RESOLVED_SCRIPTS_DIR
    if _RESOLVED_SCRIPTS_DIR is not None:
        return _RESOLVED_SCRIPTS_DIR

    cfg_dir = get_settings().pptmaster_scripts_dir
    if cfg_dir and Path(cfg_dir).is_dir():
        _RESOLVED_SCRIPTS_DIR = cfg_dir
        return cfg_dir

    # Fallback: look for the ppt-master repo relative to this project
    repo_root = Path(__file__).resolve().parents[5]  # webui root
    for candidate in [
        repo_root / ".." / "ppt-master" / "skills" / "ppt-master" / "scripts",
        repo_root / ".." / ".." / "ppt-master" / "skills" / "ppt-master" / "scripts",
    ]:
        resolved = candidate.resolve()
        if resolved.is_dir():
            _RESOLVED_SCRIPTS_DIR = str(resolved)
            return str(resolved)

    _RESOLVED_SCRIPTS_DIR = cfg_dir or "/opt/pptmaster-skill/scripts"
    return _RESOLVED_SCRIPTS_DIR


def _resolve_templates_dir() -> str:
    """Resolve the ppt-master templates directory."""
    cfg_dir = get_settings().pptmaster_templates_dir
    if cfg_dir and Path(cfg_dir).is_dir():
        return cfg_dir

    repo_root = Path(__file__).resolve().parents[5]
    for candidate in [
        repo_root / ".." / "ppt-master" / "skills" / "ppt-master" / "templates",
        repo_root / ".." / ".." / "ppt-master" / "skills" / "ppt-master" / "templates",
    ]:
        resolved = candidate.resolve()
        if resolved.is_dir():
            return str(resolved)

    return cfg_dir or "/opt/pptmaster-skill/templates"


async def run_pptx_template_import(pptx_path: str, output_dir: str | None = None) -> dict[str, Any]:
    """Run pptx_template_import.py as a subprocess and return parsed results.

    Returns a dict with:
      - temp_dir: the import output directory
      - manifest_json_path: path to manifest.json
      - svg_paths: list of generated SVG paths
      - asset_paths: list of asset file paths
      - error: str | None (None on success)
    """
    scripts_dir = _resolve_scripts_dir()
    script_path = Path(scripts_dir) / "pptx_template_import.py"

    if not script_path.is_file():
        return {
            "temp_dir": "",
            "manifest_json_path": "",
            "svg_paths": [],
            "asset_paths": [],
            "error": f"pptx_template_import.py not found at {script_path}",
        }

    if not output_dir:
        import tempfile
        output_dir = tempfile.mkdtemp(prefix="template_import_")

    cmd = [
        "python3",
        str(script_path),
        str(pptx_path),
        "-o", str(output_dir),
        "--manifest-only",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=120
        )
    except asyncio.TimeoutError:
        return {
            "temp_dir": output_dir,
            "manifest_json_path": "",
            "svg_paths": [],
            "asset_paths": [],
            "error": "pptx_template_import timed out after 120s",
        }
    except FileNotFoundError:
        return {
            "temp_dir": output_dir,
            "manifest_json_path": "",
            "svg_paths": [],
            "asset_paths": [],
            "error": "python3 not found on PATH",
        }

    if proc.returncode != 0:
        err_msg = stderr.decode("utf-8", errors="replace").strip() or stdout.decode("utf-8", errors="replace").strip()
        return {
            "temp_dir": output_dir,
            "manifest_json_path": "",
            "svg_paths": [],
            "asset_paths": [],
            "error": f"pptx_template_import failed (exit {proc.returncode}): {err_msg[:500]}",
        }

    # Collect generated files
    out = Path(output_dir)
    manifest_path = out / "manifest.json"
    svg_paths: list[str] = []
    asset_paths: list[str] = []

    if out.is_dir():
        for entry in out.rglob("*"):
            if not entry.is_file():
                continue
            rel = str(entry)
            if entry.suffix == ".svg":
                svg_paths.append(rel)
            elif entry.suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp"} or entry.parent.name == "assets":
                asset_paths.append(rel)

    return {
        "temp_dir": output_dir,
        "manifest_json_path": str(manifest_path) if manifest_path.is_file() else "",
        "svg_paths": sorted(svg_paths),
        "asset_paths": sorted(asset_paths),
        "error": None,
    }


async def run_svg_quality_checker(template_dir: str) -> dict[str, Any]:
    """Run svg_quality_checker.py --template-mode on a template directory.

    Returns {"success": bool, "errors": int, "warnings": int, "stdout": str, "stderr": str}.
    """
    scripts_dir = _resolve_scripts_dir()
    script_path = Path(scripts_dir) / "svg_quality_checker.py"

    if not script_path.is_file():
        return {"success": False, "errors": 1, "warnings": 0, "stdout": "", "stderr": f"Script not found: {script_path}"}

    # Set PYTHONPATH so the script can import sibling modules
    env = {**os.environ, "PYTHONPATH": scripts_dir}

    cmd = ["python3", str(script_path), str(template_dir), "--template-mode"]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        return {"success": False, "errors": 1, "warnings": 0, "stdout": "", "stderr": "svg_quality_checker timed out"}
    except FileNotFoundError:
        return {"success": False, "errors": 1, "warnings": 0, "stdout": "", "stderr": "python3 not found on PATH"}

    stdout_str = stdout.decode("utf-8", errors="replace")
    stderr_str = stderr.decode("utf-8", errors="replace")

    # Rough parse: count ERROR and WARN lines
    errors = stdout_str.count("[ERROR]")
    warnings = stdout_str.count("[WARN]")

    return {
        "success": proc.returncode == 0 and errors == 0,
        "errors": errors,
        "warnings": warnings,
        "stdout": stdout_str[-2000:],
        "stderr": stderr_str[-500:],
    }


async def run_register_template(template_id: str, kind: str) -> dict[str, Any]:
    """Run register_template.py to register a template in the kind-specific index.

    Returns {"success": bool, "stdout": str, "stderr": str}.
    """
    scripts_dir = _resolve_scripts_dir()
    script_path = Path(scripts_dir) / "register_template.py"

    if not script_path.is_file():
        return {"success": False, "stdout": "", "stderr": f"Script not found: {script_path}"}

    templates_dir = _resolve_templates_dir()
    env = {**os.environ, "PYTHONPATH": scripts_dir}

    # register_template.py uses SCRIPT_DIR relative path resolution internally;
    # we pass --templates-dir via env override by monkey-patching is impractical,
    # so we set PPTMASTER_TEMPLATES_DIR env var for the script to optionally use.
    cmd = ["python3", str(script_path), template_id, "--kind", kind]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        return {"success": False, "stdout": "", "stderr": "register_template timed out"}
    except FileNotFoundError:
        return {"success": False, "stdout": "", "stderr": "python3 not found on PATH"}

    stdout_str = stdout.decode("utf-8", errors="replace")
    stderr_str = stderr.decode("utf-8", errors="replace")

    return {
        "success": proc.returncode == 0,
        "stdout": stdout_str[-2000:],
        "stderr": stderr_str[-500:],
    }
