"""LangGraph state definition for PPT-Master pipeline."""

from typing import Any, Literal, NotRequired
from typing_extensions import TypedDict


class PPTMasterState(TypedDict, total=False):
    """State for the 7-step PPT generation pipeline (aligned with SKILL.md)."""

    # Identity
    project_id: str
    session_id: str
    user_id: str

    # User intent
    user_brief: str  # From Project Brief gate (step 2.5)

    # Source materials
    source_files: list[str]
    converted_markdown: list[str]

    # Template
    template_mode: str  # "free_design" | "layout" | "deck"
    template_path: str | None  # Explicit path from project creation, or None

    # Strategist outputs
    outline: dict[str, Any] | None
    design_spec_path: str | None
    spec_lock_path: str | None
    outline_path: str | None
    confirmation_progress: dict[str, str]

    # Image_Generator outputs
    image_manifest_path: str | None
    generated_images: list[dict[str, Any]]

    # Executor outputs
    svg_pages: list[str]
    quality_results: list[dict[str, Any]]

    # Post-processing outputs
    pptx_path: str | None

    # Coordinator control
    current_step: int
    completed_steps: list[int]

    # Conversation (plain list, each item is a dict with role/content)
    messages: list[dict[str, Any]]

    # Spec 4 — Page count flow
    page_count_mode: Literal["explicit", "ai_decide"] | None
    page_count: int | None
    page_count_reasoning: str | None

    # Gate 8 — Image strategy recommendation (deck_rendering / deck_palette)
    images_recommendation: dict[str, Any] | None

    # Feature: speaker-notes toggle (notes/total.md generation gate)
    generate_notes: NotRequired[bool]
