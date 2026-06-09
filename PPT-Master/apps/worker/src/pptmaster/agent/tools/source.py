"""Source processing tools (Step 1)."""

import asyncio
import os

from pptmaster.config import get_settings


def _scripts_dir() -> str:
    return get_settings().pptmaster_scripts_dir


async def run_script(
    script_name: str,
    *args: str,
    cwd: str = ".",
    timeout_sec: int = 600,
    extra_env: dict[str, str] | None = None,
) -> dict:
    """Run a PPT-Master script as subprocess and return structured result."""
    cmd = ["python3", f"{_scripts_dir()}/{script_name}", *args]
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout_sec)
        output = stdout.decode().strip()
        stderr_output = stderr.decode().strip()

        if proc.returncode != 0:
            return {"success": False, "error": stderr_output or output or "Unknown error"}

        output_path = None
        for line in f"{output}\n{stderr_output}".split("\n"):
            if line.endswith(".md") or line.endswith(".json"):
                output_path = line.strip()
                break

        return {"success": True, "output_path": output_path, "stdout": output}

    except asyncio.TimeoutError:
        return {"success": False, "error": "timeout", "hint": "File too large or took too long"}
    except FileNotFoundError:
        return {
            "success": False,
            "error": f"Script not found: {script_name}",
            "hint": f"Check PPTMASTER_SCRIPTS_DIR={_scripts_dir()}",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def pdf_to_md(file_path: str, project_path: str) -> dict:
    return await run_script("source_to_md/pdf_to_md.py", file_path, cwd=project_path)


async def doc_to_md(file_path: str, project_path: str) -> dict:
    return await run_script("source_to_md/doc_to_md.py", file_path, cwd=project_path)


async def excel_to_md(file_path: str, project_path: str) -> dict:
    return await run_script("source_to_md/excel_to_md.py", file_path, cwd=project_path)


async def ppt_to_md(file_path: str, project_path: str) -> dict:
    return await run_script("source_to_md/ppt_to_md.py", file_path, cwd=project_path)


async def web_to_md(url: str, project_path: str) -> dict:
    return await run_script("source_to_md/web_to_md.py", url, cwd=project_path, timeout_sec=120)
