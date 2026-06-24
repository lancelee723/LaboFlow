"""LangGraph Coordinator - 7-step pipeline orchestrator aligned with SKILL.md."""

import asyncio
import json
import logging
import os
import re
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, StateGraph
from langgraph.types import Command, interrupt

from pptmaster.agent.state import PPTMasterState
from pptmaster.agent.strategist import _extract_recommendation, _strategist_finalize, build_strategist_subgraph
from pptmaster.agent.tools.source import doc_to_md, excel_to_md, pdf_to_md, ppt_to_md, run_script, web_to_md
from pptmaster.agent.tools.project import project_manager_import_sources, project_manager_init
from pptmaster.agent.image_env import build_image_env
from pptmaster.agent.image_prompt_builder import (
    build_image_manifest, build_placeholder_manifest, parse_resource_rows,
)
from pptmaster.agent.image_watcher import watch_manifest_updates
from pptmaster.config import get_settings
from pptmaster.ws.manager import ws_manager
from pptmaster.llm.provider import get_chat_model
from pptmaster.scripts.total_md_split import run as _split_notes_run
from pptmaster.scripts.finalize_svg import run as _finalize_svg_run
from pptmaster.scripts.svg_to_pptx import run as _svg_to_pptx_run

logger = logging.getLogger(__name__)

# ── Step 1: Source Processing (sequential) ──────────────────────────────────


def _get_source_files(project_path: str) -> list[str]:
    """Discover source files in a project's sources/original directory."""
    original_dir = Path(project_path) / "sources" / "original"
    if not original_dir.exists():
        return []
    return sorted([str(p) for p in original_dir.iterdir() if p.is_file()])


async def step_1_source_processing(state: PPTMasterState) -> dict[str, Any]:
    """Convert uploaded source files to Markdown. Sequential, no ReAct."""
    logger.info("Step 1: Processing source files", project_id=state["project_id"])

    storage_root = get_settings().storage_root
    storage_path = f"{storage_root}/projects/{state['project_id']}"
    source_files = state.get("source_files", []) or _get_source_files(storage_path)

    if not source_files:
        return {
            "current_step": 1,
            "completed_steps": [],
            "messages": [{"role": "assistant", "content": "No source files found. Upload PDF, DOCX, or provide a URL."}],
        }

    converted = []
    converted_markdown = []
    tools = {"pdf_to_md": (".pdf", pdf_to_md),
             "doc_to_md": (".docx", doc_to_md), "doc_to_md_doc": (".doc", doc_to_md),
             "excel_to_md": (".xlsx", excel_to_md), "excel_to_md_xls": (".xls", excel_to_md),
             "ppt_to_md": (".pptx", ppt_to_md)}

    for sf in source_files:
        ext = Path(sf).suffix.lower()
        tool_name = None
        tool_fn = None
        for tn, (te, tf) in tools.items():
            if ext == te:
                tool_name, tool_fn = tn, tf
                break

        if tool_fn:
            result = await tool_fn(sf, storage_path)
            converted.append({"file": sf, "tool": tool_name, "result": result})
            if result.get("success") and result.get("output_path"):
                converted_markdown.append(result["output_path"])
        elif sf.startswith("http://") or sf.startswith("https://"):
            result = await web_to_md(sf, storage_path)
            converted.append({"file": sf, "tool": "web_to_md", "result": result})
            if result.get("success") and result.get("output_path"):
                converted_markdown.append(result["output_path"])
        elif ext in (".md", ".markdown", ".txt"):
            converted.append({"file": sf, "tool": "passthrough", "result": {"success": True, "output_path": sf}})
            converted_markdown.append(sf)

    summary = "\n".join(
        f"{'OK' if c['result'].get('success') else 'FAIL'}: {os.path.basename(c['file'])} → {c['result'].get('output_path', c['result'].get('error', '?'))}"
        for c in converted
    )

    interrupt({"gate": "source_processing", "prompt": f"Source processing complete:\n{summary}\nContinue?"})

    return {
        "converted_markdown": converted_markdown,
        "current_step": 1,
        "completed_steps": [1],
        "messages": [{"role": "assistant", "content": f"Source processing complete:\n{summary}"}],
    }


# ── Step 2: Create Project (sequential) ─────────────────────────────────────


async def step_2_create_project(state: PPTMasterState) -> dict[str, Any]:
    logger.info("Step 2: Creating project", project_id=state["project_id"])

    storage_root = get_settings().storage_root
    storage_path = f"{storage_root}/projects/{state['project_id']}"

    result = await project_manager_init(state["project_id"], base_dir=f"{storage_root}/projects")

    for md_path in state.get("converted_markdown", []):
        if os.path.exists(md_path):
            await project_manager_import_sources(storage_path, md_path, move=False)

    msg = "Project directory initialized."
    if not result.get("success"):
        msg += f" Note: {result.get('error', '')}"

    return {
        "current_step": 2,
        "completed_steps": [1, 2],
        "messages": [{"role": "assistant", "content": msg}],
    }


# ── Step 3: Template Selection ──────────────────────────────────────────────


async def step_3_template_selection(state: PPTMasterState) -> dict[str, Any]:
    """Template Selection — default free design.
    Only shows the selection gate when the user did NOT provide an explicit template path."""
    logger.info("Step 3: Template Selection", project_id=state["project_id"])

    explicit_path = state.get("template_path")
    if explicit_path:
        tmpl_dir = Path(explicit_path)
        if tmpl_dir.is_dir():
            design_spec = tmpl_dir / "design_spec.md"
            if design_spec.is_file():
                kind = "deck"
                try:
                    text = design_spec.read_text(encoding="utf-8")
                    if "kind: brand" in text[:500]:
                        kind = "brand"
                    elif "kind: layout" in text[:500]:
                        kind = "layout"
                    elif "kind: deck" in text[:500]:
                        kind = "deck"
                except Exception:
                    pass
                return {
                    "template_mode": kind,
                    "template_path": explicit_path,
                    "current_step": 3,
                    "completed_steps": state.get("completed_steps", []) + [1, 2, 3],
                    "messages": state.get("messages", []) + [
                        {"role": "assistant",
                         "content": f"Template loaded: {explicit_path} (kind={kind})"}
                    ],
                }

    response = interrupt({
        "gate": "template_selection",
        "prompt": (
            "Please select a template from the left panel, or Skip for free design. "
            "The template determines page layout structure and visual identity."
        ),
        "question_form": {
            "id": "template_selection",
            "title": "Choose a Template",
            "questions": [{
                "id": "selection",
                "type": "radio",
                "label": "Select template or skip",
                "required": True,
                "options": [
                    {"value": "free_design", "label": "Free Design (default)"},
                ],
            }],
        },
    })

    selected = "free_design"
    if isinstance(response, dict):
        answers = response.get("answers", {})
        sel = answers.get("selection", "free_design")
        if isinstance(sel, list):
            sel = sel[0] if sel else "free_design"
        selected = str(sel)

    if selected == "free_design" or selected == "skip":
        return {
            "template_mode": "free_design",
            "current_step": 3,
            "completed_steps": state.get("completed_steps", []) + [1, 2, 3],
            "messages": state.get("messages", []) + [
                {"role": "assistant", "content": "Free design — no template constraints."}
            ],
        }

    template_kind = "layout"
    template_id = selected
    templates_dir = Path(get_settings().skill_templates_root)
    if (templates_dir / "decks" / template_id).is_dir():
        template_kind = "deck"
    elif not (templates_dir / "layouts" / template_id).is_dir():
        return {
            "template_mode": "free_design",
            "current_step": 3,
            "completed_steps": state.get("completed_steps", []) + [1, 2, 3],
        }

    return {
        "template_mode": template_kind,
        "template_path": str(templates_dir / ("decks" if template_kind == "deck" else "layouts") / template_id),
        "current_step": 3,
        "completed_steps": state.get("completed_steps", []) + [1, 2, 3],
        "messages": state.get("messages", []) + [
            {"role": "assistant", "content": f"Template selected: {template_id} ({template_kind})"}
        ],
    }


# ── Step 5: Image Acquisition (conditional) ─────────────────────────────────


def _compute_phase_summary(manifest_path: Path, base_path: str) -> dict:
    """Aggregate counts from image_prompts.json + image_sources.json."""
    summary = {
        "ai": {"generated": 0, "failed": 0, "placeholder": 0},
        "web": {"sourced": 0, "placeholder": 0},
        "total": 0,
    }
    if manifest_path.is_file():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            for item in data.get("items", []):
                summary["total"] += 1
                status = item.get("status", "").lower()
                if status == "generated":
                    summary["ai"]["generated"] += 1
                elif status == "failed":
                    summary["ai"]["failed"] += 1
                elif status == "placeholder":
                    summary["ai"]["placeholder"] += 1
        except (OSError, json.JSONDecodeError):
            pass

    sources_path = Path(base_path) / "images" / "image_sources.json"
    if sources_path.is_file():
        try:
            data = json.loads(sources_path.read_text(encoding="utf-8"))
            for item in data.get("items", []):
                status = item.get("status", "").lower()
                if status == "sourced":
                    summary["web"]["sourced"] += 1
                else:
                    summary["web"]["placeholder"] += 1
                summary["total"] += 1
        except (OSError, json.JSONDecodeError):
            pass

    return summary


async def step_5_image_generator(state: PPTMasterState) -> dict[str, Any]:
    """Image Acquisition — aligned with PPT-Master image-generator.md / image-searcher.md.

    Behavior:
    - No ai/web rows → skip entirely.
    - ai rows + backend configured → build structured manifest, run image_gen.py.
    - ai rows + NO backend → write Placeholder manifest, do not invoke image_gen.py.
    - web rows → always invoke image_search.py (zero-config providers work without keys).
    """
    logger.info("Step 5: Image Acquisition", extra={"project_id": state["project_id"]})

    design_spec_path = state.get("design_spec_path")
    if not design_spec_path or not Path(design_spec_path).is_file():
        return _complete_step_5(state, message="No design_spec — skipping image phase.")

    spec_text = Path(design_spec_path).read_text(encoding="utf-8")
    rows = parse_resource_rows(spec_text)
    ai_rows = [r for r in rows if r["acquire_via"] == "ai"]
    web_rows = [r for r in rows if r["acquire_via"] == "web"]

    if not ai_rows and not web_rows:
        return _complete_step_5(state, message="No images to acquire. Skipping image phase.")

    project_id = state.get("project_id", "unknown")
    base_path = f"{get_settings().storage_root}/projects/{project_id}"
    manifest_path = Path(base_path) / "images" / "image_prompts.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    extra_env = await build_image_env()
    has_ai_backend = "IMAGE_BACKEND" in extra_env

    results = []
    manifest_written = False

    async def _with_watcher(coro_factory):
        """Run a subprocess coroutine alongside the manifest watcher."""
        sentinel = asyncio.Event()
        watcher = asyncio.create_task(
            watch_manifest_updates(
                manifest_path, state["session_id"],
                sentinel, project_id=project_id, poll_seconds=0.5,
            )
        )
        try:
            return await coro_factory()
        finally:
            sentinel.set()
            try:
                await asyncio.wait_for(watcher, timeout=5.0)
            except asyncio.TimeoutError:
                watcher.cancel()

    if ai_rows:
        if has_ai_backend:
            spec_lock_text = ""
            spec_lock_path = state.get("spec_lock_path")
            if spec_lock_path and Path(spec_lock_path).is_file():
                spec_lock_text = Path(spec_lock_path).read_text(encoding="utf-8")
            try:
                manifest = await build_image_manifest(
                    project_id=project_id,
                    ai_rows=ai_rows,
                    spec_lock_text=spec_lock_text,
                )
            except Exception as e:
                logger.warning(
                    "build_image_manifest failed (%s); falling back to placeholder",
                    e, exc_info=True,
                )
                manifest = build_placeholder_manifest(project_id=project_id, ai_rows=ai_rows)
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                manifest_written = True
                results.append(f"ai: placeholder ({len(ai_rows)} items, manifest assembly failed)")
                # Skip image_gen.py invocation since prompts are placeholders
            else:
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                manifest_written = True
                ai_result = await _with_watcher(lambda: run_script(
                    "image_gen.py", "--manifest", str(manifest_path),
                    cwd=base_path, timeout_sec=600, extra_env=extra_env,
                ))
                results.append(f"ai: {ai_result.get('success', False)}")
                if ai_result.get("success"):
                    await run_script(
                        "image_gen.py", "--render-md", str(manifest_path),
                        cwd=base_path, timeout_sec=60, extra_env=extra_env,
                    )
        else:
            manifest = build_placeholder_manifest(project_id=project_id, ai_rows=ai_rows)
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            manifest_written = True
            results.append(f"ai: placeholder ({len(ai_rows)} items)")

    if web_rows:
        web_result = await _with_watcher(lambda: run_script(
            "image_search.py", base_path,
            cwd=base_path, timeout_sec=300, extra_env=extra_env,
        ))
        results.append(f"web: {web_result.get('success', False)}")

    summary = _compute_phase_summary(manifest_path, base_path)
    await ws_manager.send_event(
        state["session_id"], "image_phase_complete", {"summary": summary},
    )
    logger.info(
        "Step 5: image_phase_complete emitted",
        extra={"project_id": project_id, "summary": summary},
    )

    result: dict[str, Any] = {
        "current_step": 5,
        "completed_steps": state.get("completed_steps", []) + [5],
        "messages": state.get("messages", []) + [
            {"role": "assistant",
             "content": f"Image acquisition complete. {', '.join(results)}"}
        ],
    }
    if manifest_written:
        result["image_manifest_path"] = str(manifest_path)
    return result


def _complete_step_5(state: PPTMasterState, message: str) -> dict[str, Any]:
    return {
        "current_step": 5,
        "completed_steps": state.get("completed_steps", []) + [5],
        "messages": state.get("messages", []) + [
            {"role": "assistant", "content": message}
        ],
    }


# ── Step 5.5: Pre-flight Review gate ────────────────────────────────────────


async def step_5_5_preflight_review(state: PPTMasterState) -> dict[str, Any]:
    """Pre-flight Review — show all decisions before starting SVG generation."""
    logger.info("Step 5.5: Pre-flight Review", project_id=state["project_id"])

    project_id = state.get("project_id", "unknown")
    base_path = Path(get_settings().storage_root) / "projects" / project_id

    # Collect summary from all previous steps
    user_brief = state.get("user_brief", "")
    template_mode = state.get("template_mode", "free_design")
    template_path = state.get("template_path", "")
    template_name = Path(template_path).name if template_path else "Free Design"

    pages: list[dict] = []
    canvas = {"format": "ppt169", "width": 1280, "height": 720}
    outline_path = Path(base_path) / "outline.json"
    if outline_path.is_file():
        try:
            outline_data = json.loads(outline_path.read_text(encoding="utf-8"))
            pages = outline_data.get("pages", [])
            canvas = outline_data.get("canvas", canvas)
        except (json.JSONDecodeError, OSError):
            pass

    spec_lock = ""
    spec_lock_path = base_path / "spec_lock.md"
    if spec_lock_path.is_file():
        try:
            spec_lock = spec_lock_path.read_text(encoding="utf-8")
        except OSError:
            pass

    # Build a structured review summary
    page_count = len(pages)
    summary = (
        f"**Ready to generate {page_count} pages on {canvas['format']}.**\n\n"
        f"Template: {template_name}\n"
        f"Canvas: {canvas['width']}x{canvas['height']} ({canvas['format']})\n\n"
    )
    if user_brief:
        summary += f"**Project Brief:**\n{user_brief[:500]}\n\n"

    summary += "**Page Outline:**\n"
    for p in pages:
        summary += f"- {p.get('index', '?')}. [{p.get('type', 'content')}] {p.get('title', 'Untitled')}\n"

    summary += f"\nReview all settings above. Click 'Start Generating PPT' to begin SVG generation."

    # Preflight summary: brief LLM review to catch obvious issues.
    # This is QA feedback for the user, not a field-pre-selection recommendation.
    preflight_rec: dict[str, Any] | None = None
    try:
        _model = await get_chat_model("strategist")
        _rec_prompt = (
            "You are reviewing a presentation design before SVG generation begins.\n\n"
            f"{summary}\n\n"
            "If you spot any issue with the settings or page outline above, describe it in one sentence.\n"
            "If everything looks good, respond with a single word: OK.\n"
            "Do NOT use any special markup or JSON blocks."
        )
        _rec_response = await _model.ainvoke(_rec_prompt)
        _rec_content = str(_rec_response.content) if hasattr(_rec_response, "content") else str(_rec_response)
        if "OK" not in _rec_content and len(_rec_content.strip()) > 5:
            preflight_rec = {"review_note": _rec_content.strip()}
    except Exception as _e:
        logger.debug(f"Preflight recommendation LLM call failed (non-fatal): {_e}")

    response = interrupt({
        "gate": "preflight_review",
        "prompt": summary,
        "recommendation": preflight_rec,
        "preflight_data": {
            "user_brief": user_brief,
            "template_name": template_name,
            "canvas_format": canvas.get("format", "ppt169"),
            "canvas_width": canvas.get("width", 1280),
            "canvas_height": canvas.get("height", 720),
            # Fallback to outline page count when state.page_count is unset
            # (defensive — strategist_finalize should always have set it).
            "page_count": state.get("page_count") or page_count,
            "page_count_reasoning": state.get("page_count_reasoning"),
            "page_count_mode": state.get("page_count_mode"),
            "pages": [{"title": p.get("title", ""), "type": p.get("type", "content")} for p in pages],
            "spec_lock": spec_lock,
        },
    })

    # ── Detect page_count_change and route back to re-finalize ────────────────
    page_count_change_raw = (
        response.get("page_count_change") if isinstance(response, dict) else None
    )
    if page_count_change_raw is not None:
        try:
            new_count = int(page_count_change_raw)
        except (TypeError, ValueError):
            new_count = None
        current_count = state.get("page_count")
        if new_count is not None and 3 <= new_count <= 100 and new_count != current_count:
            return Command(
                update={
                    "page_count": new_count,
                    "page_count_reasoning": (
                        f"User override at preflight review (was {current_count})."
                    ),
                },
                goto="step_4b_re_finalize",
            )

    return {
        "current_step": 6,
        "completed_steps": state.get("completed_steps", []) + [5],
    }


# ── Step 6: Executor SVG Generation ─────────────────────────────────────────

def _find_free_port() -> int:
    with socket.socket() as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def _svg_is_valid(filepath: Path) -> bool:
    """Return True if the SVG file exists and has valid content.

    Checks file size (minimum 200 bytes to exclude truncated writes) and
    presence of both <svg opening and </svg> closing tags.
    """
    if not filepath.exists():
        return False
    if filepath.stat().st_size < 200:
        return False
    try:
        content = filepath.read_text(encoding="utf-8")
    except OSError:
        return False
    return "<svg" in content and "</svg>" in content


def _normalize_svg_dimensions(svg: str, width: int, height: int) -> str:
    """Force pixel width/height on root <svg>.

    LLMs sometimes emit width="100%" height="100%", which renders as 0×0 inside
    an <img> tag (no intrinsic size). Strip any percentage width/height and
    inject pixel values matching the canvas.
    """
    m = re.search(r"<svg\b[^>]*>", svg)
    if not m:
        return svg
    open_tag = m.group(0)
    new_tag = open_tag
    new_tag = re.sub(r'\s+width="[^"]*%"', "", new_tag)
    new_tag = re.sub(r'\s+height="[^"]*%"', "", new_tag)
    if not re.search(r'\swidth="', new_tag):
        new_tag = new_tag.replace("<svg", f'<svg width="{width}"', 1)
    if not re.search(r'\sheight="', new_tag):
        new_tag = new_tag.replace("<svg", f'<svg height="{height}"', 1)
    if new_tag != open_tag:
        return svg.replace(open_tag, new_tag, 1)
    return svg


async def step_6_executor(state: PPTMasterState) -> dict[str, Any]:
    """Executor Phase — aligned with executor-base.md.
    Design Confirmation → Live Preview → Sequential SVG Generation → Quality Check → Speaker Notes."""
    logger.info("Step 6: Executor Phase", project_id=state["project_id"])

    project_id = state.get("project_id", "unknown")
    base_path = Path(get_settings().storage_root) / "projects" / project_id
    svg_dir = base_path / "svg_output"
    svg_dir.mkdir(parents=True, exist_ok=True)

    # --- 1. Get executor LLM ---
    try:
        model = await get_chat_model("executor")
    except RuntimeError as e:
        return {
            "current_step": 6,
            "completed_steps": state.get("completed_steps", []) + [6],
            "messages": [{"role": "assistant",
                          "content": f"Executor unavailable (no LLM): {e}"}],
        }

    # --- 2. Read outline.json + spec_lock.md ---
    spec_lock_path = base_path / "spec_lock.md"
    outline_path = base_path / "outline.json"

    spec_lock = ""
    outline_data: dict[str, Any] = {"pages": []}
    try:
        spec_lock = spec_lock_path.read_text(encoding="utf-8")
    except OSError:
        pass
    try:
        outline_data = json.loads(outline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass

    pages = outline_data.get("pages", [])
    total_pages = len(pages)
    canvas = outline_data.get("canvas", {"format": "ppt169", "width": 1280, "height": 720,
                                          "viewBox": "0 0 1280 720"})

    if total_pages == 0:
        return {
            "current_step": 6,
            "completed_steps": state.get("completed_steps", []) + [6],
            "messages": [{"role": "assistant",
                          "content": "No pages defined in outline.json. Cannot generate SVGs."}],
        }

    # Emit a priming progress event so the FE can swap from the loading
    # cover-screen to the SVG progress view immediately (instead of waiting
    # for the first page to finish rendering ~30s-1min later).
    from pptmaster.ws.manager import ws_manager as _ws_prime
    await _ws_prime.broadcast_svg_progress(
        state["session_id"], page=0, total=total_pages, filename="",
    )

    # --- 3. Design Parameter Confirmation ---
    design_msg = (
        f"**Design Parameters Confirmed**\n"
        f"- Canvas: {canvas['width']}x{canvas['height']} ({canvas['format']})\n"
        f"- Pages: {total_pages}\n"
        f"- Spec lock: {'Loaded' if spec_lock else 'Missing'}\n"
        f"Starting SVG generation..."
    )

    # --- 4. Start Live Preview subprocess ---
    live_port = _find_free_port()
    editor_proc = None
    try:
        scripts_dir = get_settings().pptmaster_scripts_dir
        editor_proc = await asyncio.create_subprocess_exec(
            'python3', f'{scripts_dir}/svg_editor/server.py',
            str(base_path), '--live', '--port', str(live_port), '--no-browser',
        )
        live_msg = f"Live Preview: http://localhost:{live_port}"
    except Exception:
        live_msg = "Live Preview could not be started."

    # --- 5. Load source content via chunker ---
    from pptmaster.agent.tools.source_chunker import chunk_sources, map_chunks_to_pages

    chunked = None
    page_chunk_map: dict[int, list] = {}
    converted = state.get("converted_markdown", [])
    if converted:
        chunked = chunk_sources(converted)
        if chunked and chunked.chunks:
            if chunked.index.source_type == "pre_divided":
                # Direct mapping: page_marker -> chunks
                for c in chunked.chunks:
                    if c.page_marker is not None:
                        page_chunk_map.setdefault(c.page_marker, []).append(c)
                    else:
                        page_chunk_map.setdefault(1, []).append(c)
            else:
                # Keyword-overlap mapping for undivided documents
                page_chunk_map = map_chunks_to_pages(chunked.chunks, pages)

    # Build compact source index for system prompt
    source_index_str = ""
    if chunked and chunked.chunks:
        source_index_str = f"## Source Document Index\n{chunked.index}\n"

    # --- 6. System prompt (reused across all pages) ---
    system_prompt = f"""You are a presentation slide designer. Output exactly ONE complete <svg>...</svg> element. No markdown wrapping, no explanation.

## Design Spec & Source Materials
The following contains the approved design spec and source document index.
Use it to produce a content-rich, accurate SVG slide. Specific source content for each page is provided separately.

## Canvas
{canvas['width']}x{canvas['height']}, viewBox="{canvas.get('viewBox', f"0 0 {canvas['width']} {canvas['height']}")}"

## Hard SVG Constraints (from shared-standards.md)
- Root <svg>: MUST include width="{canvas['width']}" height="{canvas['height']}" as pixel attributes (NEVER use "100%" or any percentage — that renders 0×0 inside <img>).
- BANNED: <style>, class, rgba(), <foreignObject>, <mask>, <g opacity>, HTML named entities, <image opacity>
- Text: one logical line = one <text> with <tspan> children. No adjacent <text> for same line.
- Groups: 3-8 top-level <g id="..."> per slide. Chrome groups id must contain bg/header/footer/nav/decor/logo/page-number.
- Icons: <use data-icon="library/name" x="..." y="..." width="..." height="..." fill="#HEX"/>
- Fonts: every font-family stack MUST end with a pre-installed system font.
- Shadows: max 2-3 per page, flood-opacity 0.06-0.12 (resting) / 0.12-0.20 (raised), all feOffset same dx/dy.
- Colors: HEX only; transparency via fill-opacity/stroke-opacity.
- Chart pages: embed <!-- chart-plot-area: x_min,y_min,x_max,y_max --> comment.

## Spec Lock Values
{spec_lock[:5000]}

{source_index_str if source_index_str else "(No source documents)"}
"""

    # --- 7. Generate SVG pages sequentially ---
    generated_pages: list[str] = []
    failed_pages: list[int] = []

    for page in pages:
        idx = page.get("index", 0)
        name = page.get("name", f"page_{idx:02d}")
        filename = f"{idx:02d}_{name}.svg"
        filepath = svg_dir / filename

        # ─ Resume: skip pages with valid pre-existing SVG files ─
        if _svg_is_valid(filepath):
            generated_pages.append(str(filepath))
            logger.info(f"Page {idx}/{total_pages}: {filename} already exists, skipping")
            continue

        page_label = f"page_{idx:02d}_{name}"
        t_page_start = time.monotonic()
        logger.info("perf_page_start", extra={"page": page_label, "idx": idx, "total": total_pages})

        rhythm = page.get("rhythm", "dense")
        layout_basename = page.get("layout_basename")

        rhythm_rules = {
            "anchor": "Structural page. Follow the template verbatim.",
            "dense": "Information-heavy. Multi-column, card grids, KPI dashboards permitted.",
            "breathing": "Low-density impact page. NO multi-card grids. Use whitespace, naked text blocks.",
        }

        page_context = f"""## Current Page
- Filename: {filename}
- Index: {idx}/{total_pages}
- Type: {page.get('type', 'content')}
- Rhythm: {rhythm} — {rhythm_rules.get(rhythm, 'dense default')}
- Layout reference: {layout_basename or 'None (free design)'}
- Title: {page.get('title', '')}
- Subtitle: {page.get('subtitle', '')}
- Content points (from strategist outline):
"""
        for c in page.get("content", []):
            page_context += f"  • {c}\n"
        if not page.get("content"):
            page_context += "  (No specific content brief — use the source document to fill this page)\n"

        # Inject per-page relevant source chunks
        relevant_chunks = page_chunk_map.get(idx, [])
        if relevant_chunks:
            excerpt_parts = []
            for chunk in relevant_chunks:
                excerpt_parts.append(f"### {chunk.title}\n{chunk.text}")
            page_context += f"\n## Source Content for This Page\n{'—'.join(excerpt_parts)}\n"
        elif chunked and chunked.chunks:
            # Fallback: find the chunk closest in sequence to this page
            closest = min(chunked.chunks, key=lambda c: abs(c.index - idx), default=None)
            if closest:
                page_context += f"\n## Source Content (nearest section)\n### {closest.title}\n{closest.text}\n"

        prompt = system_prompt + "\n" + page_context + "\nOutput only the <svg> element:"

        # ── LLM call ──────────────────────────────────────────────────────────
        t_llm_start = time.monotonic()
        svg_content = ""
        for attempt in range(2):
            try:
                response = await model.ainvoke(prompt)
                text = response.content if hasattr(response, "content") else str(response)

                # G4.8: Track token usage
                input_tokens = 0
                output_tokens = 0
                if hasattr(response, "usage_metadata"):
                    um = response.usage_metadata
                    input_tokens = um.get("input_tokens", 0) if isinstance(um, dict) else 0
                    output_tokens = um.get("output_tokens", 0) if isinstance(um, dict) else 0
                if input_tokens or output_tokens:
                    from pptmaster.llm.provider import record_token_usage
                    _ = asyncio.create_task(record_token_usage(
                        user_id=state.get("user_id", ""),
                        project_id=project_id,
                        session_id=state["session_id"],
                        agent_role="executor",
                        provider="anthropic" if "anthropic" in str(type(response)).lower() else "unknown",
                        model="unknown",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                    ))

                svg_start = text.find("<svg")
                svg_end = text.rfind("</svg>")
                if svg_start != -1 and svg_end != -1:
                    svg_content = text[svg_start:svg_end + 6]
                    break
                else:
                    svg_content = text
            except Exception as e:
                logger.warning(f"Page {idx} SVG attempt {attempt+1} failed: {e}")
                if attempt == 1:
                    failed_pages.append(idx)
        t_llm_done = time.monotonic()
        logger.info("perf_llm_done", extra={"page": page_label, "elapsed_s": round(t_llm_done - t_llm_start, 3)})

        # ── SVG validation (extract + structural check) ───────────────────────
        svg_valid = bool(svg_content and "<svg" in svg_content)
        t_validation_done = time.monotonic()
        logger.info("perf_validation_done", extra={"page": page_label, "elapsed_s": round(t_validation_done - t_llm_done, 3), "valid": svg_valid})

        # ── Disk write ────────────────────────────────────────────────────────
        if svg_valid:
            svg_content = _normalize_svg_dimensions(svg_content, canvas["width"], canvas["height"])
            filepath.write_text(svg_content, encoding="utf-8")
            generated_pages.append(str(filepath))
            logger.info(f"Page {idx}/{total_pages}: {filename} written")
        else:
            placeholder = (
                f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'viewBox="0 0 {canvas["width"]} {canvas["height"]}" '
                f'width="{canvas["width"]}" height="{canvas["height"]}">'
                f'<rect width="{canvas["width"]}" height="{canvas["height"]}" fill="#1a1a2e"/>'
                f'<text x="{canvas["width"]//2}" y="{canvas["height"]//2}" '
                f'text-anchor="middle" fill="#888888" font-size="24" '
                f'font-family="Arial, sans-serif">'
                f'Page {idx}: Generation failed</text></svg>'
            )
            filepath.write_text(placeholder, encoding="utf-8")
            generated_pages.append(str(filepath))
            failed_pages.append(idx)
        t_disk_write_done = time.monotonic()
        logger.info("perf_disk_write_done", extra={"page": page_label, "elapsed_s": round(t_disk_write_done - t_validation_done, 3)})

        # ── WS broadcast ──────────────────────────────────────────────────────
        from pptmaster.ws.manager import ws_manager as _ws
        await _ws.broadcast_svg_progress(
            state["session_id"], page=idx, total=total_pages, filename=filename,
        )
        if svg_valid:
            await _ws.broadcast_artifact_updated(
                state["session_id"], project_id, f"svg_output/{filename}", "svg", "created",
            )
        t_broadcast_done = time.monotonic()
        logger.info("perf_broadcast_done", extra={"page": page_label, "elapsed_s": round(t_broadcast_done - t_disk_write_done, 3)})

        logger.info("perf_page_total", extra={"page": page_label, "elapsed_s": round(t_broadcast_done - t_page_start, 3)})

    # --- 7. Quality Check ---
    t_qc_start = time.monotonic()
    qc_result = await run_script("svg_quality_checker.py", str(base_path),
                                  cwd=str(base_path), timeout_sec=120)
    t_qc_done = time.monotonic()
    logger.info("perf_qc_done", extra={"elapsed_s": round(t_qc_done - t_qc_start, 3)})

    # G4.12: QC auto-retry — 1 retry per failed page with QC issue context
    qc_failed_pages: list[int] = []
    if isinstance(qc_result, dict) and not qc_result.get("success"):
        pages_data = qc_result.get("pages", {})
        if isinstance(pages_data, dict):
            for page_key, page_info in pages_data.items():
                if isinstance(page_info, dict) and not page_info.get("success", True):
                    try:
                        qc_failed_pages.append(int(page_key))
                    except (ValueError, TypeError):
                        pass

    _retried_count = 0
    _qc_warn_pages: list[int] = []
    for _fp in qc_failed_pages:
        if _retried_count >= len(qc_failed_pages):
            break  # one retry per page max
        _fp_pages = [p for p in pages if p.get("index") == _fp]
        if not _fp_pages:
            continue
        _fp_page = _fp_pages[0]
        _fp_name = _fp_page.get("name", f"page_{_fp:02d}")
        _fp_filename = f"{_fp:02d}_{_fp_name}.svg"
        _fp_path = svg_dir / _fp_filename
        if not _fp_path.exists():
            continue
        try:
            _original_svg = _fp_path.read_text(encoding="utf-8")
        except OSError:
            continue

        # Get QC issues for this page
        _page_issues = []
        _pages_data = qc_result.get("pages", {}) if isinstance(qc_result, dict) else {}
        _pi = _pages_data.get(str(_fp), {})
        if isinstance(_pi, dict):
            _page_issues = _pi.get("issues", [])
        _issues_text = "\n".join(
            f"- {i.get('rule', '?')}: {i.get('message', '')}" for i in _page_issues
        ) if _page_issues else "Unknown QC issues"

        _retry_prompt = (
            f"The SVG for page '{_fp_filename}' has quality issues. Fix ALL issues below:\n"
            f"{_issues_text}\n\n"
            f"Original SVG:\n{_original_svg[:4000]}\n\n"
            "Output ONLY the corrected, complete <svg>...</svg> element."
        )
        try:
            _retry_response = await model.ainvoke(_retry_prompt)
            _retry_text: str = str(getattr(_retry_response, "content", _retry_response))
            _svg_start = _retry_text.find("<svg")
            _svg_end = _retry_text.rfind("</svg>")
            if _svg_start != -1 and _svg_end != -1 and _svg_is_valid(_fp_path):
                _fp_path.write_text(_retry_text[_svg_start:_svg_end + 6], encoding="utf-8")
                _retried_count += 1
                logger.info(f"QC retry: page {_fp} regenerated successfully")
            else:
                _qc_warn_pages.append(_fp)
                logger.warning(f"QC retry: page {_fp} still failing")
        except Exception as _re:
            _qc_warn_pages.append(_fp)
            logger.warning(f"QC retry: page {_fp} exception: {_re}")

    if _qc_warn_pages:
        qc_result = {"success": False, "warning_pages": _qc_warn_pages,
                      "message": f"QC retry failed for pages: {_qc_warn_pages}"}

    # --- 8. Speaker Notes ---
    notes_msg = "Speaker notes not generated."
    t_notes_start = time.monotonic()
    logger.info("perf_inter_step_gap", extra={"from_step": "svg_generation", "to_step": "speaker_notes"})
    try:
        notes_prompt = (
            "Write complete speaker notes for this presentation. "
            "One section per page: '# NN_name' heading, then 2-5 natural spoken sentences. "
            "Pages separated by '---'. No bracketed markers, no meta-lines.\n\n"
            f"Outline: {json.dumps(pages, ensure_ascii=False, indent=2)}"
        )
        notes_response = await model.ainvoke(notes_prompt)
        notes_text = notes_response.content if hasattr(notes_response, "content") else ""
        notes_dir = base_path / "notes"
        notes_dir.mkdir(parents=True, exist_ok=True)
        (notes_dir / "total.md").write_text(notes_text, encoding="utf-8")
        notes_msg = "Speaker notes written to notes/total.md"
    except Exception as e:
        logger.warning(f"Speaker notes generation failed: {e}")
    t_notes_done = time.monotonic()
    logger.info("perf_notes_done", extra={"elapsed_s": round(t_notes_done - t_notes_start, 3)})

    # --- 9. Summary ---
    fail_info = f" | {len(failed_pages)} pages failed: {failed_pages}" if failed_pages else ""

    # Broadcast progress to chat
    from pptmaster.ws.manager import ws_manager as _ws
    await _ws.broadcast_agent_message(
        state["session_id"], "executor",
        f"Generated {len(generated_pages)}/{total_pages} SVG pages.{fail_info}\nQuality check: {'PASS' if qc_result.get('success') else 'ISSUES FOUND'}\n{notes_msg}"
    )

    return {
        "current_step": 6,
        "completed_steps": state.get("completed_steps", []) + [6],
        "svg_pages": generated_pages,
        "quality_results": [qc_result],
        "messages": state.get("messages", []) + [
            {"role": "assistant",
             "content": (
                 f"{design_msg}\n{live_msg}\n"
                 f"Generated {len(generated_pages)}/{total_pages} SVG pages.{fail_info}\n"
                 f"Quality check: {'PASS' if qc_result.get('success') else 'ISSUES FOUND'}\n"
                 f"{notes_msg}"
             )}
        ],
    }


# ── Step 7: Post-processing & Export ────────────────────────────────────────


async def step_7_post_processing(state: PPTMasterState) -> dict[str, Any]:
    """Post-processing & Export — aligned with SKILL.md Step 7.
    Validates svg_output/ has files before running, exports/output.pptx after."""
    logger.info("Step 7: Post-processing", project_id=state["project_id"])

    project_id = state["project_id"]
    base_path = Path(get_settings().storage_root) / "projects" / project_id

    svg_dir = base_path / "svg_output"
    pptx_path = base_path / "exports" / "output.pptx"

    # Pre-check: must have SVGs
    if not svg_dir.exists() or not list(svg_dir.glob("*.svg")):
        return {
            "current_step": 7,
            "completed_steps": state.get("completed_steps", []) + [7],
            "messages": state.get("messages", []) + [
                {"role": "assistant",
                 "content": "Error: No SVG files found in svg_output/. Pipeline cannot proceed."}
            ],
        }

    pptx_str = str(pptx_path)

    errors: list[str] = []

    for label, fn in [
        ("total_md_split", _split_notes_run),
        ("finalize_svg", _finalize_svg_run),
        ("svg_to_pptx", _svg_to_pptx_run),
    ]:
        try:
            fn(base_path)
        except Exception as e:
            logger.error(f"step_7 {label} failed: {e}")
            errors.append(f"{label}: {e}")

    if errors:
        return {
            "current_step": 7,
            "messages": state.get("messages", []) + [
                {"role": "system", "content": f"Post-processing errors: {'; '.join(errors)}"}
            ],
        }

    from pptmaster.ws.manager import ws_manager as _ws2
    if pptx_path.is_file():
        await _ws2.broadcast_artifact_updated(
            state["session_id"], project_id, "exports/output.pptx", "export", "created",
        )

    completion_content = (
        f"Pipeline complete!\n\n"
        f"PPTX exported to: `{pptx_str}`\n\n"
        f"Summary: AI-generated presentation\nTags: presentation"
    )
    # Broadcast to the FE via WS (single source of truth — covers both fresh and
    # resumed pipeline paths; orchestrate.py no longer adds a second broadcast).
    await _ws2.broadcast_agent_message(
        state["session_id"], "coordinator", completion_content
    )

    return {
        "current_step": 7,
        "completed_steps": [1, 2, 3, 4, 5, 6, 7],
        "pptx_path": pptx_str,
        "messages": state.get("messages", []) + [
            {"role": "assistant", "content": completion_content}],
    }


# ── Step 4b: Re-finalize after preflight page_count override ────────────────


async def step_4b_re_finalize(state: PPTMasterState) -> dict[str, Any]:
    """Re-run strategist_finalize when the user changed page_count at preflight.

    Skips all 8 gates (already approved). Calls _strategist_finalize directly
    with the updated state.page_count, then returns to image generation.
    """
    logger.info(
        "Step 4b: Re-finalize after preflight page_count override",
        project_id=state.get("project_id"),
        new_page_count=state.get("page_count"),
    )
    result = await _strategist_finalize(state)
    # Override current_step so the pipeline progresses to step 5
    result["current_step"] = 5
    return result


# ── Graph construction ──────────────────────────────────────────────────────


def create_coordinator_graph(checkpointer=None):
    graph = StateGraph(PPTMasterState)
    strategist_subgraph = build_strategist_subgraph().compile(checkpointer=checkpointer)

    graph.add_node("step_1_source_processing", step_1_source_processing)
    graph.add_node("step_2_create_project", step_2_create_project)
    graph.add_node("step_3_template_selection", step_3_template_selection)
    graph.add_node("step_4_strategist", strategist_subgraph)
    graph.add_node("step_4b_re_finalize", step_4b_re_finalize)
    graph.add_node("step_5_image_generator", step_5_image_generator)
    graph.add_node("step_5_5_preflight_review", step_5_5_preflight_review)
    graph.add_node("step_6_executor", step_6_executor)
    graph.add_node("step_7_post_processing", step_7_post_processing)

    graph.set_entry_point("step_1_source_processing")
    graph.add_edge("step_1_source_processing", "step_2_create_project")
    graph.add_edge("step_2_create_project", "step_3_template_selection")
    graph.add_edge("step_3_template_selection", "step_4_strategist")
    graph.add_edge("step_4_strategist", "step_5_image_generator")
    # step_4b_re_finalize feeds back into step_5 (image gen) then back to preflight
    graph.add_edge("step_4b_re_finalize", "step_5_image_generator")
    graph.add_edge("step_5_image_generator", "step_5_5_preflight_review")
    graph.add_edge("step_5_5_preflight_review", "step_6_executor")
    graph.add_edge("step_6_executor", "step_7_post_processing")
    graph.add_edge("step_7_post_processing", END)

    return graph


@asynccontextmanager
async def compiled_coordinator():
    """Yield a compiled LangGraph with async-context-managed Postgres checkpointer."""
    settings = get_settings()
    url = settings.database_url.replace("+asyncpg", "")
    async with AsyncPostgresSaver.from_conn_string(url) as checkpointer:
        await checkpointer.setup()
        graph = create_coordinator_graph(checkpointer=checkpointer).compile(checkpointer=checkpointer)
        yield graph


async def compile_coordinator() -> None:
    """DEPRECATED — use 'async with compiled_coordinator() as graph:' instead."""
    raise RuntimeError(
        "compile_coordinator() is deprecated. Use 'async with compiled_coordinator() as graph:' "
        "to ensure the AsyncPostgresSaver context is active for graph operations."
    )
