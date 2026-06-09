"""Tests for image prompt assembly."""
from pptmaster.agent.image_prompt_builder import parse_resource_rows


def test_parse_resource_rows_extracts_ai_and_web():
    spec = """
## §VIII Image Resource List

| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |
|---|---|---|---|---|---|---|
| cover.png | 1280x720 | Cover background | Background | `ai` | Pending | Modern tech abstract |
| team.jpg | 800x600 | Team photo | Photography | `web` | Pending | Diverse team in office |
| logo.png | 200x200 | Logo | Logo | `user` | Existing | (user-provided) |
"""
    rows = parse_resource_rows(spec)
    assert len(rows) == 3

    cover = rows[0]
    assert cover["filename"] == "cover.png"
    assert cover["dimensions"] == "1280x720"
    assert cover["purpose"] == "Cover background"
    assert cover["acquire_via"] == "ai"
    assert cover["reference"] == "Modern tech abstract"

    assert rows[1]["acquire_via"] == "web"
    assert rows[2]["acquire_via"] == "user"


def test_parse_resource_rows_empty_when_no_section():
    spec = "## Some other section\n\nNo table here."
    assert parse_resource_rows(spec) == []


def test_parse_resource_rows_handles_no_backticks_around_acquire_via():
    """Strategist sometimes drops the backticks."""
    spec = """
| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |
|---|---|---|---|---|---|---|
| pic.png | 800x600 | Hero | Background | ai | Pending | Abstract |
"""
    rows = parse_resource_rows(spec)
    assert len(rows) == 1
    assert rows[0]["acquire_via"] == "ai"


def test_parse_resource_rows_tolerates_blank_line_inside_table():
    spec = """
| Filename | Dimensions | Purpose | Type | Acquire Via | Status | Reference |
|---|---|---|---|---|---|---|
| a.png | 800x600 | First | bg | ai | Pending | A |

| b.png | 800x600 | Second | bg | ai | Pending | B |
"""
    rows = parse_resource_rows(spec)
    assert len(rows) == 2
    assert rows[0]["filename"] == "a.png"
    assert rows[1]["filename"] == "b.png"


from pptmaster.agent.image_prompt_builder import parse_spec_lock_for_images


def test_parse_spec_lock_with_new_fields():
    spec_lock = """
images:
  strategy: ai_generated
  deck_rendering: vector-illustration
  deck_palette: cool-corporate
colors:
  primary: "#1E3A5F"
  secondary: "#F8F9FA"
  accent: "#D4AF37"
"""
    parsed = parse_spec_lock_for_images(spec_lock)
    assert parsed["deck_rendering"] == "vector-illustration"
    assert parsed["deck_palette"] == "cool-corporate"
    assert parsed["colors"]["primary"] == "#1E3A5F"


def test_parse_spec_lock_legacy_falls_back_to_defaults():
    spec_lock = """
images:
  strategy: ai_generated
colors:
  primary: "#000"
  secondary: "#FFF"
  accent: "#F00"
"""
    parsed = parse_spec_lock_for_images(spec_lock)
    assert parsed["deck_rendering"] == "vector-illustration"  # default
    assert parsed["deck_palette"] == "cool-corporate"          # default
    assert parsed["colors"]["primary"] == "#000"


def test_parse_spec_lock_empty_returns_defaults():
    parsed = parse_spec_lock_for_images("")
    assert parsed["deck_rendering"] == "vector-illustration"
    assert parsed["deck_palette"] == "cool-corporate"
    assert parsed["colors"] == {}


import pytest


@pytest.mark.asyncio
async def test_translate_references_batches_in_one_call(monkeypatch):
    from pptmaster.agent.image_prompt_builder import translate_references_to_visual

    call_count = {"n": 0}

    class FakeModel:
        async def ainvoke(self, prompt):
            call_count["n"] += 1
            # Return a JSON object mapping each filename to a visual line
            class R:
                content = (
                    '{"cover.png": "Layered digital waves across the canvas",'
                    ' "team.jpg": "Group of professionals around a laptop in a sunlit room"}'
                )
            return R()

    async def fake_get_chat_model(role):
        return FakeModel()

    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.get_chat_model", fake_get_chat_model,
    )

    rows = [
        {"filename": "cover.png", "reference": "Abstract digital waves"},
        {"filename": "team.jpg", "reference": "Engineering team collaborating"},
    ]
    result = await translate_references_to_visual(rows)
    assert call_count["n"] == 1   # exactly one LLM call for both rows
    assert "cover.png" in result
    assert "team.jpg" in result
    assert "Layered digital waves" in result["cover.png"]


@pytest.mark.asyncio
async def test_translate_references_empty_input_skips_llm(monkeypatch):
    from pptmaster.agent.image_prompt_builder import translate_references_to_visual

    called = {"yes": False}

    async def fake_get_chat_model(role):
        called["yes"] = True
        raise AssertionError("should not be called")

    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.get_chat_model", fake_get_chat_model,
    )
    result = await translate_references_to_visual([])
    assert result == {}
    assert called["yes"] is False


def test_read_reference_file_loads_rendering(monkeypatch, tmp_path):
    from pptmaster.agent.image_prompt_builder import read_reference_file

    # Fake references dir
    rendering_dir = tmp_path / "image-renderings"
    rendering_dir.mkdir()
    (rendering_dir / "vector-illustration.md").write_text(
        "# Vector Illustration\n\nClean flat vector style paragraph (80-120 words) ...",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder._references_root",
        lambda: str(tmp_path),
    )

    text = read_reference_file("image-renderings/vector-illustration.md")
    assert "Vector Illustration" in text


def test_read_reference_file_missing_returns_none(monkeypatch, tmp_path):
    from pptmaster.agent.image_prompt_builder import read_reference_file
    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder._references_root",
        lambda: str(tmp_path),
    )
    assert read_reference_file("image-renderings/nonexistent.md") is None


def test_read_reference_file_caches(monkeypatch, tmp_path):
    """Second read of the same file shouldn't re-touch disk."""
    from pptmaster.agent.image_prompt_builder import read_reference_file, _clear_reference_cache

    target = tmp_path / "image-palettes" / "cool-corporate.md"
    target.parent.mkdir()
    target.write_text("first version", encoding="utf-8")

    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder._references_root",
        lambda: str(tmp_path),
    )

    _clear_reference_cache()
    first = read_reference_file("image-palettes/cool-corporate.md")
    target.write_text("second version", encoding="utf-8")
    second = read_reference_file("image-palettes/cool-corporate.md")
    assert first == second == "first version"  # cached


@pytest.mark.asyncio
async def test_build_image_manifest_includes_deck_fields(monkeypatch, tmp_path):
    from pptmaster.agent.image_prompt_builder import build_image_manifest, _clear_reference_cache

    # Stub references dir with minimal content
    refs = tmp_path / "references"
    (refs / "image-renderings").mkdir(parents=True)
    (refs / "image-palettes").mkdir(parents=True)
    (refs / "image-renderings" / "vector-illustration.md").write_text(
        "Style paragraph for vector illustration.", encoding="utf-8",
    )
    (refs / "image-palettes" / "cool-corporate.md").write_text(
        "Palette rules for cool corporate.", encoding="utf-8",
    )
    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder._references_root",
        lambda: str(refs),
    )
    _clear_reference_cache()

    async def fake_get_chat_model(role):
        class M:
            async def ainvoke(self, prompt):
                class R: content = '{"cover.png": "Concrete visual scene"}'
                return R()
        return M()
    monkeypatch.setattr(
        "pptmaster.agent.image_prompt_builder.get_chat_model", fake_get_chat_model,
    )

    rows = [{
        "filename": "cover.png",
        "purpose": "Cover background",
        "acquire_via": "ai",
        "reference": "Abstract digital waves",
        "dimensions": "1280x720",
    }]
    spec_lock_text = (
        "images:\n  deck_rendering: vector-illustration\n  deck_palette: cool-corporate\n"
        'colors:\n  primary: "#1E3A5F"\n  secondary: "#F8F9FA"\n  accent: "#D4AF37"\n'
    )

    manifest = await build_image_manifest(
        project_id="proj1",
        ai_rows=rows,
        spec_lock_text=spec_lock_text,
    )

    assert manifest["deck_rendering"] == "vector-illustration"
    assert manifest["deck_palette"] == "cool-corporate"
    assert manifest["color_scheme"]["primary"] == "#1E3A5F"
    assert len(manifest["items"]) == 1

    item = manifest["items"][0]
    assert item["filename"] == "cover.png"
    assert item["status"] == "Pending"
    assert item["page_role"] in ("local", "hero_page")
    assert "Style paragraph for vector illustration." in item["prompt"]
    assert "Palette rules for cool corporate." in item["prompt"]
    assert "Concrete visual scene" in item["prompt"]
    assert "1280" in item["prompt"] or "16:9" in item["prompt"]


def test_text_policy_clause_handles_embedded():
    from pptmaster.agent.image_prompt_builder import _text_policy_clause
    clause = _text_policy_clause("embedded")
    assert clause  # non-empty
    assert "artwork" in clause.lower() or "lettering" in clause.lower()


def test_build_placeholder_manifest_marks_all_placeholder():
    from pptmaster.agent.image_prompt_builder import build_placeholder_manifest

    rows = [
        {"filename": "a.png", "purpose": "p1", "acquire_via": "ai", "reference": "x", "dimensions": "800x600"},
        {"filename": "b.png", "purpose": "p2", "acquire_via": "ai", "reference": "y", "dimensions": "800x600"},
    ]
    manifest = build_placeholder_manifest(project_id="p1", ai_rows=rows)
    assert all(item["status"] == "Placeholder" for item in manifest["items"])
    assert len(manifest["items"]) == 2
    # Reason field explains why
    assert "no backend" in manifest["items"][0].get("last_error", "").lower()
