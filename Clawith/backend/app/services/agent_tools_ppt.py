"""PPT-specific agent tools for the ppt-master skill.

Tools:
  - ask_direction:   Ask the user to choose a style direction before generating.
  - generate_slides: Output a full slide deck as SVG.
  - export_pptx:     Export the current deck as a .pptx file.
"""

from __future__ import annotations

import json
from typing import Any

# ---------------------------------------------------------------------------
# Tool definitions (OpenAI function-calling schema)
# ---------------------------------------------------------------------------

ASK_DIRECTION_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "ask_direction",
        "description": (
            "Ask the user to choose a visual style direction for the slides. "
            "Present a set of direction cards and wait for the user's choice."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to ask the user about their preferred style direction.",
                },
                "cards": {
                    "type": "array",
                    "description": "Direction cards for the user to choose from.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Unique identifier for this direction card."},
                            "label": {"type": "string", "description": "Short display label."},
                            "mood": {"type": "string", "description": "Mood or atmosphere description."},
                            "palette": {
                                "type": "object",
                                "description": "Color palette for this direction.",
                                "properties": {
                                    "primary": {"type": "string"},
                                    "secondary": {"type": "string"},
                                    "accent": {"type": "string"},
                                    "background": {"type": "string"},
                                    "text": {"type": "string"},
                                    "text_secondary": {"type": "string"},
                                },
                                "required": ["primary", "secondary", "accent", "background", "text", "text_secondary"],
                            },
                            "display_font": {"type": "string", "description": "Display/heading font name."},
                            "body_font": {"type": "string", "description": "Body text font name."},
                            "references": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Reference images or examples for this direction.",
                            },
                        },
                        "required": ["id", "label", "mood", "palette", "display_font", "body_font", "references"],
                    },
                },
            },
            "required": ["question", "cards"],
        },
    },
}

GENERATE_SLIDES_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "generate_slides",
        "description": (
            "Generate a complete slide deck as SVG. Each slide is provided as an "
            "inline SVG string with an accompanying speaker note."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Title of the slide deck.",
                },
                "palette": {
                    "type": "object",
                    "description": "Color palette used across the deck.",
                    "properties": {
                        "primary": {"type": "string"},
                        "secondary": {"type": "string"},
                        "accent": {"type": "string"},
                        "background": {"type": "string"},
                        "text": {"type": "string"},
                        "text_secondary": {"type": "string"},
                    },
                    "required": ["primary", "secondary", "accent", "background", "text", "text_secondary"],
                },
                "display_font": {
                    "type": "string",
                    "description": "Display/heading font name.",
                },
                "body_font": {
                    "type": "string",
                    "description": "Body text font name.",
                },
                "slides": {
                    "type": "array",
                    "description": "Ordered list of slides.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Unique slide identifier."},
                            "svg": {"type": "string", "description": "SVG markup for the slide."},
                            "note": {"type": "string", "description": "Speaker note for the slide."},
                        },
                        "required": ["id", "svg", "note"],
                    },
                },
            },
            "required": ["title", "palette", "display_font", "body_font", "slides"],
        },
    },
}

EXPORT_PPTX_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "export_pptx",
        "description": "Export the current slide deck as a PowerPoint (.pptx) file.",
        "parameters": {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Output filename for the .pptx file (without extension).",
                },
            },
            "required": ["filename"],
        },
    },
}

PPT_TOOLS: list[dict[str, Any]] = [
    ASK_DIRECTION_TOOL,
    GENERATE_SLIDES_TOOL,
    EXPORT_PPTX_TOOL,
]

# ---------------------------------------------------------------------------
# Execute functions
# ---------------------------------------------------------------------------


async def execute_ask_direction(args: dict, db, agent_id: int, user_id: int) -> str:
    """Execute the ask_direction tool.

    Returns a JSON string containing the direction data so the caller can
    forward it to the WebSocket client and pause the LLM loop.
    """
    result = {
        "tool": "ask_direction",
        "question": args.get("question", ""),
        "cards": args.get("cards", []),
    }
    return json.dumps(result, ensure_ascii=False)


async def execute_generate_slides(args: dict, db, agent_id: int, user_id: int) -> str:
    """Execute the generate_slides tool.

    Returns a JSON string confirming the slide count and status.
    """
    slides = args.get("slides", [])
    result = {
        "tool": "generate_slides",
        "slide_count": len(slides),
        "status": "generated",
    }
    return json.dumps(result, ensure_ascii=False)


async def execute_export_pptx(args: dict, db, agent_id: int, user_id: int) -> str:
    """Execute the export_pptx tool.

    Returns a JSON string confirming the export filename and status.
    """
    result = {
        "tool": "export_pptx",
        "filename": args.get("filename", "presentation"),
        "status": "exported",
    }
    return json.dumps(result, ensure_ascii=False)
