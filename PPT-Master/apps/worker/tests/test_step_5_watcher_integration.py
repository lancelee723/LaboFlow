"""Integration test: watcher runs alongside image_gen subprocess."""
import asyncio
import json
from pathlib import Path

import pytest

from pptmaster.agent.coordinator import step_5_image_generator


@pytest.mark.asyncio
async def test_step_5_starts_watcher_and_emits_phase_complete(tmp_path, monkeypatch):
    spec = tmp_path / "design_spec.md"
    spec.write_text(
        "| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |\n"
        "|---|---|---|---|---|---|---|\n"
        "| a.png | 800x600 | Cover | bg | ai | Pending | abstract |\n",
        encoding="utf-8",
    )
    lock = tmp_path / "spec_lock.md"
    lock.write_text(
        "images:\n  deck_rendering: vector-illustration\n  deck_palette: cool-corporate\n",
        encoding="utf-8",
    )

    events: list[tuple] = []
    class FakeWs:
        async def send_event(self, session_id, event_type, data):
            events.append((event_type, data))
    monkeypatch.setattr("pptmaster.agent.coordinator.ws_manager", FakeWs(), raising=False)
    monkeypatch.setattr("pptmaster.agent.image_watcher.ws_manager", FakeWs(), raising=False)

    async def fake_env():
        return {"IMAGE_BACKEND": "gemini", "GEMINI_API_KEY": "k"}
    monkeypatch.setattr("pptmaster.agent.coordinator.build_image_env", fake_env)

    async def fake_run_script(script_name, *args, **kwargs):
        # Simulate CLI updating manifest status while watcher is alive
        if script_name == "image_gen.py" and "--manifest" in args:
            manifest_path = Path(args[args.index("--manifest") + 1])
            await asyncio.sleep(0.3)
            data = json.loads(manifest_path.read_text())
            data["items"][0]["status"] = "Generated"
            manifest_path.write_text(json.dumps(data))
            await asyncio.sleep(0.5)
        return {"success": True}
    monkeypatch.setattr("pptmaster.agent.coordinator.run_script", fake_run_script)

    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.read_reference_file",
        lambda p: "stub",
    )
    async def fake_translate(rows):
        return {r["filename"]: r["reference"] for r in rows}
    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.translate_references_to_visual",
        fake_translate,
    )

    class _FakeSettings: storage_root = str(tmp_path)
    monkeypatch.setattr("pptmaster.agent.coordinator.get_settings", lambda: _FakeSettings())
    (tmp_path / "projects" / "p1" / "images").mkdir(parents=True)

    state = {
        "project_id": "p1", "session_id": "s1",
        "design_spec_path": str(spec), "spec_lock_path": str(lock),
        "messages": [], "completed_steps": [],
    }
    await step_5_image_generator(state)

    types = [t for t, _ in events]
    assert "image_status_update" in types
    assert "image_phase_complete" in types
    # Phase complete summary should reflect 1 generated
    phase = [d for t, d in events if t == "image_phase_complete"][0]
    assert phase["summary"]["ai"]["generated"] >= 1
