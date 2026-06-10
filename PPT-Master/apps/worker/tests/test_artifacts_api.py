from pathlib import Path

import pytest

from pptmaster.api.artifacts import collect_project_artifacts, resolve_artifact_path


def test_collect_project_artifacts_discovers_supported_workspace_files(tmp_path: Path) -> None:
    (tmp_path / "outline.json").write_text('{"title": "Deck"}', encoding="utf-8")
    (tmp_path / "design_spec.md").write_text("# Design spec", encoding="utf-8")
    (tmp_path / "spec_lock.md").write_text("# Spec lock", encoding="utf-8")

    svg_dir = tmp_path / "svg_output"
    svg_dir.mkdir()
    (svg_dir / "page_001.svg").write_text("<svg></svg>", encoding="utf-8")

    image_dir = tmp_path / "images"
    image_dir.mkdir()
    (image_dir / "hero.png").write_bytes(b"png")

    export_dir = tmp_path / "exports"
    export_dir.mkdir()
    (export_dir / "deck.pptx").write_bytes(b"pptx")

    artifacts = collect_project_artifacts(tmp_path)

    assert [artifact["path"] for artifact in artifacts] == [
        "outline.json",
        "design_spec.md",
        "spec_lock.md",
        "svg_output/page_001.svg",
        "images/hero.png",
        "exports/deck.pptx",
    ]
    assert [artifact["content_type"] for artifact in artifacts] == [
        "text",
        "text",
        "text",
        "svg",
        "image",
        "download",
    ]


def test_resolve_artifact_path_rejects_parent_directory_escape(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        resolve_artifact_path(tmp_path, "../secrets.txt")