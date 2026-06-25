"""Tests for step_5_image_generator rewrite."""
import json
from pathlib import Path

import pytest

from pptmaster.agent.coordinator import step_5_image_generator


@pytest.mark.asyncio
async def test_step_5_llm_failure_falls_back_to_placeholder(tmp_path, monkeypatch):
    spec_path = tmp_path / "design_spec.md"
    spec_path.write_text(
        "| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |\n"
        "|---|---|---|---|---|---|---|\n"
        "| cover.png | 1280x720 | Cover | Background | ai | Pending | Abstract |\n",
        encoding="utf-8",
    )
    spec_lock_path = tmp_path / "spec_lock.md"
    spec_lock_path.write_text("images:\n  deck_rendering: vector-illustration\n", encoding="utf-8")

    async def fake_build_env():
        return {"IMAGE_BACKEND": "gemini", "GEMINI_API_KEY": "k"}
    monkeypatch.setattr("pptmaster.agent.coordinator.build_image_env", fake_build_env)

    async def boom(*args, **kwargs):
        raise RuntimeError("simulated LLM outage")
    monkeypatch.setattr("pptmaster.agent.coordinator.build_image_manifest", boom)

    class _FakeSettings:
        storage_root = str(tmp_path)
    monkeypatch.setattr("pptmaster.agent.coordinator.get_settings", lambda: _FakeSettings())
    (tmp_path / "projects" / "p1" / "images").mkdir(parents=True)

    state = {
        "project_id": "p1", "session_id": "s1",
        "design_spec_path": str(spec_path), "spec_lock_path": str(spec_lock_path),
        "messages": [], "completed_steps": [],
    }
    # Must NOT raise
    result = await step_5_image_generator(state)
    assert 5 in result["completed_steps"]
    manifest = json.loads(Path(result["image_manifest_path"]).read_text())
    assert manifest["items"][0]["status"] == "Placeholder"


@pytest.mark.asyncio
async def test_step_5_web_only_no_manifest_path(tmp_path, monkeypatch):
    spec_path = tmp_path / "design_spec.md"
    spec_path.write_text(
        "| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |\n"
        "|---|---|---|---|---|---|---|\n"
        "| team.jpg | 800x600 | Team | Photo | web | Pending | Engineering team |\n",
        encoding="utf-8",
    )
    spec_lock_path = tmp_path / "spec_lock.md"
    spec_lock_path.write_text("", encoding="utf-8")

    async def fake_env():
        return {}
    monkeypatch.setattr("pptmaster.agent.coordinator.build_image_env", fake_env)

    async def fake_run_script(*args, **kwargs):
        return {"success": True}
    monkeypatch.setattr("pptmaster.agent.coordinator.run_script", fake_run_script)

    class _FakeSettings:
        storage_root = str(tmp_path)
    monkeypatch.setattr("pptmaster.agent.coordinator.get_settings", lambda: _FakeSettings())
    (tmp_path / "projects" / "p1" / "images").mkdir(parents=True)

    state = {
        "project_id": "p1", "session_id": "s1",
        "design_spec_path": str(spec_path), "spec_lock_path": str(spec_lock_path),
        "messages": [], "completed_steps": [],
    }
    result = await step_5_image_generator(state)
    assert 5 in result["completed_steps"]
    assert "image_manifest_path" not in result   # no manifest was written


@pytest.mark.asyncio
async def test_step_5_skips_when_no_ai_or_web_rows(tmp_path, monkeypatch):
    spec_path = tmp_path / "design_spec.md"
    spec_path.write_text("## Some content\n\nNo image table.", encoding="utf-8")

    state = {
        "project_id": "p1",
        "session_id": "s1",
        "design_spec_path": str(spec_path),
        "spec_lock_path": str(tmp_path / "spec_lock.md"),
        "messages": [],
        "completed_steps": [],
    }
    result = await step_5_image_generator(state)
    assert 5 in result["completed_steps"]
    assert "image_manifest_path" not in result


@pytest.mark.asyncio
async def test_step_5_no_backend_writes_placeholder_manifest(tmp_path, monkeypatch):
    spec_path = tmp_path / "design_spec.md"
    spec_path.write_text(
        "| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |\n"
        "|---|---|---|---|---|---|---|\n"
        "| cover.png | 1280x720 | Cover | Background | ai | Pending | Abstract waves |\n",
        encoding="utf-8",
    )
    spec_lock_path = tmp_path / "spec_lock.md"
    spec_lock_path.write_text("images:\n  strategy: ai_generated\n", encoding="utf-8")

    async def fake_build_env():
        return {}  # no IMAGE_BACKEND
    monkeypatch.setattr(
        "pptmaster.agent.coordinator.build_image_env", fake_build_env,
    )

    class _FakeSettings:
        storage_root = str(tmp_path)
    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings", lambda: _FakeSettings(),
    )
    (tmp_path / "projects" / "p1" / "images").mkdir(parents=True)

    state = {
        "project_id": "p1",
        "session_id": "s1",
        "design_spec_path": str(spec_path),
        "spec_lock_path": str(spec_lock_path),
        "messages": [],
        "completed_steps": [],
    }
    result = await step_5_image_generator(state)
    manifest_path = Path(result["image_manifest_path"])
    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["items"][0]["status"] == "Placeholder"


@pytest.mark.asyncio
async def test_step_5_with_backend_runs_image_gen(tmp_path, monkeypatch):
    spec_path = tmp_path / "design_spec.md"
    spec_path.write_text(
        "| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |\n"
        "|---|---|---|---|---|---|---|\n"
        "| cover.png | 1280x720 | Cover | Background | ai | Pending | Abstract |\n",
        encoding="utf-8",
    )
    spec_lock_path = tmp_path / "spec_lock.md"
    spec_lock_path.write_text(
        "images:\n  deck_rendering: vector-illustration\n  deck_palette: cool-corporate\n",
        encoding="utf-8",
    )

    async def fake_build_env():
        return {"IMAGE_BACKEND": "gemini", "GEMINI_API_KEY": "k"}
    monkeypatch.setattr(
        "pptmaster.agent.coordinator.build_image_env", fake_build_env,
    )
    captured = {}
    async def fake_run_script(script_name, *args, **kwargs):
        captured["script"] = script_name
        captured["extra_env"] = kwargs.get("extra_env")
        return {"success": True}
    monkeypatch.setattr(
        "pptmaster.agent.coordinator.run_script", fake_run_script,
    )
    # Stub the LLM and reference dir so build_image_manifest doesn't hit real LLM/disk
    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.read_reference_file",
        lambda p: "stub paragraph",
    )
    async def fake_translate(rows):
        return {r["filename"]: r["reference"] for r in rows}
    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.translate_references_to_visual",
        fake_translate,
    )
    class _FakeSettings:
        storage_root = str(tmp_path)
    monkeypatch.setattr(
        "pptmaster.agent.coordinator.get_settings", lambda: _FakeSettings(),
    )
    (tmp_path / "projects" / "p1" / "images").mkdir(parents=True)

    state = {
        "project_id": "p1",
        "session_id": "s1",
        "design_spec_path": str(spec_path),
        "spec_lock_path": str(spec_lock_path),
        "messages": [],
        "completed_steps": [],
    }
    await step_5_image_generator(state)
    assert captured["script"] == "image_gen.py"
    assert captured["extra_env"]["IMAGE_BACKEND"] == "gemini"
