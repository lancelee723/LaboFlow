"""Image manifest assembly: parse design_spec.md §VIII, assemble prompts.

References:
- skills/ppt-master/references/image-base.md
- skills/ppt-master/references/image-generator.md
"""

from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import TypedDict

from pptmaster.config import get_settings
from pptmaster.llm.provider import get_chat_model

logger = logging.getLogger(__name__)


class ResourceRow(TypedDict, total=False):
    filename: str
    dimensions: str
    purpose: str
    type_hint: str
    acquire_via: str
    status: str
    reference: str
    page_role: str
    text_policy: str
    aspect_ratio: str


_TABLE_HEADER_RE = re.compile(
    r"\|\s*Filename\s*\|\s*Dimensions\s*\|\s*Purpose\s*\|\s*Type\s*\|\s*Acquire Via\s*\|\s*Status\s*\|\s*Reference\s*\|",
    re.IGNORECASE,
)
_ROW_RE = re.compile(r"\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|")


def parse_resource_rows(design_spec_md: str) -> list[ResourceRow]:
    """Extract resource list rows from design_spec.md §VIII.

    Returns list of dicts. Filters out the header and separator rows.
    Acquire Via is normalized (strips backticks and whitespace).
    """
    rows: list[ResourceRow] = []
    in_table = False
    for line in design_spec_md.splitlines():
        if _TABLE_HEADER_RE.search(line):
            in_table = True
            continue
        if in_table:
            stripped = line.strip()
            if not stripped:
                # Blank line — tolerate within table (don't exit)
                continue
            if not stripped.startswith("|"):
                # Non-pipe line — table ends
                in_table = False
                continue
            if set(stripped.replace("|", "").strip()) <= {"-", " ", ":"}:
                # separator row
                continue
            m = _ROW_RE.match(stripped)
            if not m:
                continue
            cells = [c.strip() for c in m.groups()]
            acquire_via = cells[4].strip().strip("`").strip().lower()
            rows.append({
                "filename": cells[0],
                "dimensions": cells[1],
                "purpose": cells[2],
                "type_hint": cells[3],
                "acquire_via": acquire_via,
                "status": cells[5],
                "reference": cells[6],
            })
    return rows


DEFAULT_DECK_RENDERING = "vector-illustration"
DEFAULT_DECK_PALETTE = "cool-corporate"


def parse_spec_lock_for_images(spec_lock_md: str) -> dict:
    """Extract the bits needed for image manifest assembly from spec_lock.md.

    Returns:
        {
            "deck_rendering": str,   # falls back to DEFAULT_DECK_RENDERING
            "deck_palette": str,     # falls back to DEFAULT_DECK_PALETTE
            "colors": {"primary": str, "secondary": str, "accent": str},
        }

    spec_lock.md is YAML-shaped Markdown. We do a tolerant scan rather than
    full YAML parsing because spec_lock.md is human-edited and may have
    surrounding prose between sections.
    """
    result = {
        "deck_rendering": DEFAULT_DECK_RENDERING,
        "deck_palette": DEFAULT_DECK_PALETTE,
        "colors": {},
    }

    in_images = False
    in_colors = False
    for raw in spec_lock_md.splitlines():
        line = raw.rstrip()
        if line.startswith("images:"):
            in_images, in_colors = True, False
            continue
        if line.startswith("colors:"):
            in_images, in_colors = False, True
            continue
        if line and not line.startswith(" ") and not line.startswith("\t"):
            in_images, in_colors = False, False
            continue

        if in_images:
            m = re.match(r"\s+(\w+):\s*(.+)$", line)
            if m:
                key, value = m.group(1), m.group(2).strip().strip('"').strip("'")
                if key in ("deck_rendering", "deck_palette"):
                    result[key] = value

        if in_colors:
            m = re.match(r"\s+(\w+):\s*(.+)$", line)
            if m:
                key, value = m.group(1), m.group(2).strip().strip('"').strip("'")
                if key in ("primary", "secondary", "accent"):
                    result["colors"][key] = value

    return result


async def translate_references_to_visual(rows: list[dict]) -> dict[str, str]:
    """Batch-translate intent-style Reference fields into concrete visual nouns.

    PPT-Master image-base.md §8 distinguishes intent vs. query. Strategist
    writes free-form intent like "Diverse engineering team..."; the prompt
    needs concrete visual nouns. We batch all rows into one LLM call to keep
    token cost down (see Spec §3.4).

    Returns: {filename: "one-sentence visual description"}.
    """
    if not rows:
        return {}

    items = [{"filename": r["filename"], "reference": r.get("reference", "")} for r in rows]
    instruction = (
        "For each entry below, rewrite the `reference` into a single concrete "
        "visual sentence (≤ 50 words) that names what should be in the image — "
        "subjects, composition, lighting, mood. Do not invent specific brand names. "
        "Output strict JSON: an object mapping each filename to its visual sentence. "
        "No other text.\n\nEntries:\n"
        + json.dumps(items, ensure_ascii=False, indent=2)
    )

    model = await get_chat_model("image_generator")
    response = await model.ainvoke(instruction)
    content = response.content if hasattr(response, "content") else str(response)

    try:
        # Tolerate code fences
        cleaned = content.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        parsed = json.loads(cleaned)
        if not isinstance(parsed, dict):
            raise ValueError("Expected JSON object")
        return {str(k): str(v) for k, v in parsed.items()}
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("translate_references_to_visual: parse failed (%s); falling back to raw references", e)
        return {r["filename"]: r.get("reference", "") for r in rows}


def _references_root() -> str:
    return get_settings().pptmaster_references_dir


@lru_cache(maxsize=64)
def _read_reference_file_cached(root: str, relative_path: str) -> str | None:
    """Internal cache layer; root is passed so monkeypatching _references_root
    invalidates per-test (since root changes)."""
    full = Path(root) / relative_path
    if not full.is_file():
        return None
    try:
        return full.read_text(encoding="utf-8")
    except OSError:
        return None


def read_reference_file(relative_path: str) -> str | None:
    """Read a file under references/ with caching.

    relative_path is rooted at references/ (e.g. 'image-renderings/vector-illustration.md').
    Returns None on missing/unreadable.
    """
    return _read_reference_file_cached(_references_root(), relative_path)


def _clear_reference_cache() -> None:
    """Test helper: drop the LRU cache."""
    _read_reference_file_cached.cache_clear()


from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Aspect-ratio / size helpers
# ---------------------------------------------------------------------------

def _aspect_ratio_from_dimensions(dimensions: str) -> str:
    try:
        w, h = dimensions.lower().split("x")
        w, h = int(w), int(h)
        ratio = w / h
        for target, name in [
            (16 / 9, "16:9"),
            (4 / 3, "4:3"),
            (3 / 4, "3:4"),
            (9 / 16, "9:16"),
            (1.0, "1:1"),
            (3 / 2, "3:2"),
            (2 / 3, "2:3"),
        ]:
            if abs(ratio - target) < 0.05:
                return name
        return "16:9"
    except (ValueError, ZeroDivisionError):
        return "16:9"


def _infer_image_size(page_role: str) -> str:
    return "2K" if page_role == "hero_page" else "1K"


def _infer_page_role(row: dict) -> str:
    purpose = row.get("purpose", "").lower()
    if any(k in purpose for k in ("cover", "chapter", "divider", "hero", "closing", "transition")):
        return "hero_page"
    return "local"


def _infer_text_policy(row: dict) -> str:
    purpose = row.get("purpose", "").lower()
    if any(k in purpose for k in ("typographic", "big number", "headline", "stat")):
        return "embedded"
    return "none"


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

_HARD_RULES = (
    "Color values (HEX codes like #1E3A5F) and color names are rendering "
    "guidance only — do NOT display HEX codes, color names, or palette labels "
    "as visible text anywhere in the image. "
    "Human figures appear as simplified stylized silhouettes or symbolic "
    "representations — no photorealistic faces, no detailed anatomy."
)


def _text_policy_clause(policy: str) -> str:
    if policy == "none":
        return (
            "NO text of any kind anywhere in the image — no letters, "
            "numbers, signs, watermarks, labels, or written symbols."
        )
    if policy == "embedded":
        return (
            "Text may appear as part of the artwork (designed lettering, "
            "decorative wording, or hand-rendered keywords) consistent with "
            "the visual description above. Keep any in-image text short and "
            "stable — long copy belongs in the SVG overlay."
        )
    return ""


def _container_note(aspect_ratio: str, page_role: str) -> str:
    return f"Composed as a {aspect_ratio} image for {page_role} use."


def _assemble_prompt(
    rendering_md: str,
    palette_md: str,
    colors: dict,
    type_md: str | None,
    page_role: str,
    text_policy: str,
    visual_description: str,
    aspect_ratio: str,
) -> str:
    """Concatenate the 6 paragraphs per image-generator.md §4."""
    palette_with_colors = palette_md + (
        f" Use primary {colors.get('primary', '')}, secondary {colors.get('secondary', '')}, "
        f"accent {colors.get('accent', '')}."
    )
    parts = [
        rendering_md.strip(),
        palette_with_colors.strip(),
    ]
    if type_md:
        parts.append(type_md.strip())
    parts.extend([
        visual_description.strip(),
        _container_note(aspect_ratio, page_role),
        _text_policy_clause(text_policy),
        _HARD_RULES,
    ])
    return " ".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# Public manifest builders
# ---------------------------------------------------------------------------

async def build_image_manifest(
    project_id: str,
    ai_rows: list[dict],
    spec_lock_text: str,
) -> dict:
    """Assemble image_prompts.json conforming to image-generator.md §6."""
    parsed = parse_spec_lock_for_images(spec_lock_text)
    rendering = parsed["deck_rendering"]
    palette = parsed["deck_palette"]
    colors = parsed["colors"]

    rendering_md = read_reference_file(f"image-renderings/{rendering}.md") or ""
    palette_md = read_reference_file(f"image-palettes/{palette}.md") or ""

    visual_map = await translate_references_to_visual(ai_rows)

    items = []
    for row in ai_rows:
        page_role = row.get("page_role") or _infer_page_role(row)
        text_policy = row.get("text_policy") or _infer_text_policy(row)
        aspect_ratio = row.get("aspect_ratio") or _aspect_ratio_from_dimensions(row.get("dimensions", ""))

        img_type = None
        type_md = None
        if page_role == "local":
            img_type = "framework"  # PR1 default; PR2 enhances via _index.md lookup
            type_md = read_reference_file(f"image-type-templates/{img_type}.md")

        prompt = _assemble_prompt(
            rendering_md=rendering_md,
            palette_md=palette_md,
            colors=colors,
            type_md=type_md,
            page_role=page_role,
            text_policy=text_policy,
            visual_description=visual_map.get(row["filename"], row.get("reference", "")),
            aspect_ratio=aspect_ratio,
        )

        items.append({
            "filename": row["filename"],
            "purpose": row.get("purpose", ""),
            "type": img_type,
            "page_role": page_role,
            "text_policy": text_policy,
            "aspect_ratio": aspect_ratio,
            "image_size": _infer_image_size(page_role),
            "prompt": prompt,
            "status": "Pending",
        })

    return {
        "project": project_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "deck_rendering": rendering,
        "deck_palette": palette,
        "color_scheme": colors,
        "items": items,
    }


def build_placeholder_manifest(project_id: str, ai_rows: list[dict]) -> dict:
    """No backend configured — produce a manifest where every item is Placeholder."""
    return {
        "project": project_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "deck_rendering": DEFAULT_DECK_RENDERING,
        "deck_palette": DEFAULT_DECK_PALETTE,
        "color_scheme": {},
        "items": [
            {
                "filename": r["filename"],
                "purpose": r.get("purpose", ""),
                "page_role": _infer_page_role(r),
                "text_policy": _infer_text_policy(r),
                "aspect_ratio": _aspect_ratio_from_dimensions(r.get("dimensions", "")),
                "status": "Placeholder",
                "last_error": "no backend configured",
            }
            for r in ai_rows
        ],
    }
