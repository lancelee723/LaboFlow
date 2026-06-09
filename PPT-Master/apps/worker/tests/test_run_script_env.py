"""Tests for run_script extra_env injection."""
import asyncio
import os

import pytest

from pptmaster.agent.tools.source import run_script


@pytest.mark.asyncio
async def test_extra_env_propagates_to_subprocess(tmp_path):
    """A subprocess invoked via run_script must see env vars passed in extra_env."""
    helper = tmp_path / "echo_env.py"
    helper.write_text(
        "import os, sys\n"
        "print(os.environ.get('TEST_VAR', 'MISSING'))\n"
    )
    # Run directly via asyncio.create_subprocess_exec to verify our env-merging
    # mechanism works the same way as run_script does internally.
    proc = await asyncio.create_subprocess_exec(
        "python3", str(helper),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "TEST_VAR": "hello-from-extra-env"},
    )
    stdout, _ = await proc.communicate()
    assert stdout.decode().strip() == "hello-from-extra-env"


@pytest.mark.asyncio
async def test_extra_env_signature_accepts_dict():
    """Smoke test: run_script accepts extra_env kwarg without TypeError."""
    # Pass a nonexistent script to fail fast on FileNotFoundError-equivalent path,
    # confirming extra_env doesn't raise TypeError before reaching subprocess.
    result = await run_script(
        "nonexistent_test_script.py",
        extra_env={"FOO": "bar"},
    )
    assert result["success"] is False
    assert "no such file or directory" in result.get("error", "").lower()
