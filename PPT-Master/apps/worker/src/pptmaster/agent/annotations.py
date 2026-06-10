"""Per-page annotation utilities — ported from the Flask svg_editor server."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)

EDIT_ID_PREFIX = "_edit_"
DATA_EDIT_TARGET = "data-edit-target"
DATA_EDIT_ANNOTATION = "data-edit-annotation"

# SVG namespace commonly used in generated files
_SVG_NS = "http://www.w3.org/2000/svg"

# Regex to detect and strip XML namespace prefix in tag names
_NS_RE = re.compile(r"^\{[^}]*\}")


def _local_tag(element: ET.Element) -> str:
    """Return the local (no-namespace) tag name."""
    return _NS_RE.sub("", element.tag)


def set_annotation(root: ET.Element, element_id: str, annotation_text: str) -> bool:
    """Write data-edit-target / data-edit-annotation attributes to the target element.

    Searches all descendants for an element whose ``id`` attribute matches
    *element_id*.  When found, sets ``data-edit-target`` to the element's
    local tag name and ``data-edit-annotation`` to *annotation_text*.

    Returns ``True`` if the element was found and annotated, ``False`` otherwise.
    """
    for elem in root.iter():
        if elem.get("id") == element_id:
            tag = _local_tag(elem)
            elem.set(DATA_EDIT_TARGET, tag)
            elem.set(DATA_EDIT_ANNOTATION, annotation_text)
            return True
    return False


def strip_transient_ids(root: ET.Element, annotated_ids: set[str]) -> None:
    """Remove id attributes starting with ``_edit_`` from elements that were NOT annotated.

    Only elements whose id is in *annotated_ids* keep their transient id.
    Everything else that has an ``_edit_N`` id gets that attribute removed so
    the written SVG stays clean.
    """
    for elem in root.iter():
        eid = elem.get("id", "")
        if eid.startswith(EDIT_ID_PREFIX) and eid not in annotated_ids:
            del elem.attrib["id"]


def parse_annotations(root: ET.Element) -> dict[str, str]:
    """Read data-edit-* attributes from the SVG, return ``{element_id: annotation_text}``.

    Elements that carry ``data-edit-annotation`` but lack an ``id`` are skipped
    because the id is the lookup key used by the regeneration loop.
    """
    result: dict[str, str] = {}
    for elem in root.iter():
        annotation = elem.get(DATA_EDIT_ANNOTATION)
        if annotation is not None:
            eid = elem.get("id")
            if eid:
                result[eid] = annotation
    return result


def build_regeneration_prompt(
    page_index: int,
    total: int,
    page_title: str,
    svg_content: str,
    annotations: dict[str, str],
) -> str:
    """Construct the per-page LLM prompt per spec Feature 2 format.

    Multiple annotations on the same page are batched into one prompt with one
    ``Element ... User annotation`` block per annotation entry.
    """
    lines: list[str] = [
        f'Page {page_index}/{total}: "{page_title}"',
        "Current SVG content:",
        svg_content,
        "",
    ]

    for element_id, annotation_text in annotations.items():
        # Best-effort element text extraction from the SVG string
        element_text = _extract_element_text(svg_content, element_id)
        lines.append(f'Element "{element_id}" (text content: "{element_text}"):')
        lines.append(f'  User annotation: "{annotation_text}"')
        lines.append("")

    lines += [
        "Regenerate this page's SVG, incorporating all the changes above.",
        "Preserve all other elements, styling, and layout unchanged.",
        "Return ONLY the complete modified SVG.",
    ]

    return "\n".join(lines)


def _extract_element_text(svg_content: str, element_id: str) -> str:
    """Best-effort extraction of text content for an element by id.

    Parses the SVG string; returns the stripped text content if found.
    Falls back to empty string on any parse error.
    """
    try:
        root = ET.fromstring(svg_content)
    except ET.ParseError:
        return ""

    for elem in root.iter():
        if elem.get("id") == element_id:
            texts: list[str] = []
            if elem.text:
                texts.append(elem.text.strip())
            for child in elem:
                if child.text:
                    texts.append(child.text.strip())
                if child.tail:
                    texts.append(child.tail.strip())
            return " ".join(t for t in texts if t)

    return ""


async def regenerate_page(
    page_file: Path,
    annotations: dict[str, str],
    project_path: Path,
    model: Any,
) -> dict[str, Any]:
    """Full per-page regeneration loop.

    1. Read the current SVG from *page_file*.
    2. Write ``data-edit-*`` attributes to annotated elements.
    3. Build the LLM prompt.
    4. Call ``model.ainvoke(prompt)`` and validate the response contains a ``<svg>`` tag.
    5. Write the regenerated SVG back to *page_file*.
    6. Strip transient ``_edit_N`` ids from non-annotated elements.

    Returns a dict ``{success: bool, error: str | None, page_file: str}``.
    """
    if not page_file.exists():
        return {
            "success": False,
            "error": f"Page file not found: {page_file}",
            "page_file": str(page_file),
        }

    try:
        svg_content = page_file.read_text(encoding="utf-8")
    except OSError as exc:
        return {
            "success": False,
            "error": f"Cannot read SVG file: {exc}",
            "page_file": str(page_file),
        }

    # Derive page metadata from the filename, e.g. "03_Overview.svg"
    stem = page_file.stem  # "03_Overview"
    parts = stem.split("_", 1)
    try:
        page_index = int(parts[0])
    except (ValueError, IndexError):
        page_index = 0
    page_title = parts[1].replace("_", " ") if len(parts) > 1 else stem

    # Count total pages in svg_output directory
    svg_dir = project_path / "svg_output"
    total_pages = len(list(svg_dir.glob("*.svg"))) if svg_dir.is_dir() else 1

    # Build and invoke the prompt
    prompt = build_regeneration_prompt(
        page_index=page_index,
        total=total_pages,
        page_title=page_title,
        svg_content=svg_content,
        annotations=annotations,
    )

    try:
        response = await model.ainvoke(prompt)
        response_text: str = (
            response.content if hasattr(response, "content") else str(response)
        )
    except Exception as exc:
        logger.warning("LLM call failed for %s: %s", page_file.name, exc)
        return {
            "success": False,
            "error": f"LLM invocation failed: {exc}",
            "page_file": str(page_file),
        }

    # Validate: response must contain a complete SVG element
    svg_start = response_text.find("<svg")
    svg_end = response_text.rfind("</svg>")
    if svg_start == -1 or svg_end == -1:
        return {
            "success": False,
            "error": "LLM response does not contain a valid <svg>...</svg> element",
            "page_file": str(page_file),
        }

    regenerated_svg = response_text[svg_start : svg_end + 6]

    # Parse the regenerated SVG, strip transient ids, write back
    try:
        regen_root = ET.fromstring(regenerated_svg)
    except ET.ParseError as exc:
        return {
            "success": False,
            "error": f"Regenerated SVG is not valid XML: {exc}",
            "page_file": str(page_file),
        }

    annotated_ids = set(annotations.keys())
    strip_transient_ids(regen_root, annotated_ids)

    final_svg = ET.tostring(regen_root, encoding="unicode", xml_declaration=False)
    try:
        page_file.write_text(final_svg, encoding="utf-8")
    except OSError as exc:
        return {
            "success": False,
            "error": f"Cannot write regenerated SVG: {exc}",
            "page_file": str(page_file),
        }

    logger.info("Regenerated page %s (%d annotations)", page_file.name, len(annotations))
    return {
        "success": True,
        "error": None,
        "page_file": str(page_file),
    }
