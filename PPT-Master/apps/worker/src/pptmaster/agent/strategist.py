"""Strategist ReAct agent subgraph with 8 blocking gates.

Maps SKILL.md §4.3 — Eight Confirmations (strategist.md §1):
  Gate 1: Canvas Format
  Gate 2: Page Count
  Gate 3: Target Audience + Use Case
  Gate 4: Style Objective (A/B/C mode + visual descriptor)
  Gate 5: Color Scheme (HEX)
  Gate 6: Icon Usage (library + inventory)
  Gate 7: Typography Plan + Formula Policy
  Gate 8: Image Strategy (ai/web/user/placeholder)
"""

import json
import logging
import re
from pathlib import Path
from typing import Any

from langgraph.graph import StateGraph
from langgraph.types import interrupt

from pptmaster.agent.image_strategy_recommender import (
    load_palette_index_summary,
    load_rendering_index_summary,
)
from pptmaster.agent.state import PPTMasterState
from pptmaster.agent.tools.template import list_charts, list_icons, list_layouts, read_template_spec
from pptmaster.config import get_settings
from pptmaster.llm.provider import get_chat_model

logger = logging.getLogger(__name__)


def _extract_recommendation(content: str) -> tuple[str, dict[str, Any] | None]:
    """Strip the <<RECOMMENDATION>>...<<END>> block from LLM output.

    Returns (cleaned_content, rec_dict_or_none).  Extraction failure (no block
    found or invalid JSON) yields (original_content, None) — not an error.
    """
    m = re.search(r"<<RECOMMENDATION>>(.*?)<<END>>", content, re.DOTALL)
    if not m:
        return content, None
    try:
        rec = json.loads(m.group(1))
        cleaned = content[: m.start()] + content[m.end() :]
        return cleaned.strip(), rec
    except json.JSONDecodeError:
        return content, None


def _load_source_excerpt(converted_markdown: list[str], max_chars: int) -> str:
    """Load actual source content for LLM context. `converted_markdown` is a
    list of file paths — this reads them via chunk_sources and returns a
    title+text excerpt of the first few chunks, truncated to `max_chars`.
    """
    if not converted_markdown:
        return ""
    try:
        from pptmaster.agent.tools.source_chunker import chunk_sources
        chunked = chunk_sources(converted_markdown)
        if not chunked or not chunked.chunks:
            return ""
        parts = [f"### {c.title}\n{c.text}" for c in chunked.chunks[:3]]
        return ("\n\n".join(parts))[:max_chars]
    except Exception as e:
        logger.debug(f"_load_source_excerpt failed (non-fatal): {e}")
        return ""


EIGHT_GATES = [
    "canvas",
    "page_count",
    "audience",
    "style",
    "colors",
    "icons",
    "typography",
    "images",
]

GATE_TITLES = {
    "canvas": "Canvas Format",
    "page_count": "Page Count",
    "audience": "Target Audience",
    "style": "Style Objective",
    "colors": "Color Scheme",
    "icons": "Icon Usage",
    "typography": "Typography Plan",
    "images": "Image Strategy",
}

GATE_PROMPTS = {
    "canvas": (
        "Select the canvas format for your presentation. Available options:\n\n"
        "- **PPT 16:9** (1280x720) — Business presentations, meetings\n"
        "- **PPT 4:3** (1024x768) — Traditional projectors, academic talks\n"
        "- **Xiaohongshu/RED** (1242x1660) — Image-text sharing, knowledge posts\n"
        "- **WeChat Moments/IG** (1080x1080) — Square posters, brand showcases\n"
        "- **Story/TikTok** (1080x1920) — Vertical stories, short video covers\n"
        "- **WeChat Article Header** (900x383) — WeChat article cover images\n"
        "- **Landscape Banner** (1920x1080) — Web banners, digital screens\n"
        "- **Portrait Poster** (1080x1920) — Phone screens, elevator ads\n"
        "- **A4 Print** (1240x1754) — Print posters, flyers\n\n"
        "Recommend one based on the content scenario and target audience."
    ),
    "page_count": (
        "Determine the page count for this presentation.\n\n"
        "**CRITICAL RULE**: If the user's prompt or source document specifies a page count "
        "or page division (e.g., '第1页', 'Page 1', '## 第N页'), you MUST follow it exactly. "
        "Do NOT add, remove, or merge pages.\n\n"
        "Only recommend a page count when the user has NOT specified one."
    ),
    "audience": "Confirm target audience, usage occasion, and core message.",
    "style": "Recommend communication mode (A: Versatile / B: Consulting / C: Top Consulting) and visual style descriptor.",
    "colors": "Recommend color scheme (HEX values) based on content and industry.",
    "icons": (
        "Choose one icon library for the entire deck (mixing is forbidden).\n\n"
        "- **Chunk Filled**: straight-line geometry, sharp corners, structured — best for business/government\n"
        "- **Tabler Filled**: bezier curves, smooth rounded contours — softer modern look\n"
        "- **Tabler Outline**: line-art thin strokes (1.5/2/3px) — minimalist, screen-only decks\n"
        "- **Phosphor Duotone**: single color + 20% backplate — soft depth, modern UI feel\n\n"
        "Recommend one and list the approved icon names the executor may use."
    ),
    "typography": (
        "Recommend font combination and body font size for this deck.\n\n"
        "Font combos to consider:\n"
        "- Serif x Sans (Georgia+KaiTi titles, Microsoft YaHei body) — professional contrast\n"
        "- Kai x Hei (KaiTi titles, Microsoft YaHei body) — calligraphic + modern\n"
        "- Government (SimHei titles, SimSun body) — authoritative, 公文风格\n"
        "- Tech (Arial throughout + Consolas code) — clean monospace pairing\n"
        "- Concord (Microsoft YaHei throughout) — one family, consistent\n\n"
        "Body size: Relaxed (24px) for keynote/training, Dense (18px) for consulting/data.\n"
        "Formula policy: mixed (default), render-all, or text-only.\n\n"
        "Recommend one combo + body size + formula policy."
    ),
    "images": (
        "Classify the image strategy for this deck. Choose a default:\n\n"
        "- **AI Generated**: conceptual visuals, hero images, mood-setting — via DALL-E/Stable Diffusion\n"
        "- **Web Sourced**: real-world photos, news imagery — with attribution\n"
        "- **User Provided**: company logos, team photos, branded assets — referenced as-is\n"
        "- **Placeholder**: no image yet — executor draws dashed-border placeholder\n\n"
        "Recommend a default strategy and note any pages that need a different approach."
    ),
}

# Per-gate example schemas for the tag-block recommendation instruction.
_GATE_REC_EXAMPLES: dict[str, str] = {
    "canvas": '{"format": "ppt169"}',
    "page_count": '{"count": 12, "mode": "explicit"}',
    "audience": '{"audience": "C-suite executives", "occasion": "quarterly board review", "core_message": "Q3 growth exceeded projections"}',
    "style": '{"mode": "consulting", "descriptor": "data-dense with clear hierarchy"}',
    "colors": '{"primary": "#1A365D", "accent": "#E53E3E", "background": "#FFFFFF", "body_text": "#2D3748", "secondary_text": "#718096", "border": "#E2E8F0"}',
    "icons": '{"library": "chunk_filled", "approved_icons": ["bar-chart", "users", "target", "trending-up"]}',
    "typography": '{"title_family": "Georgia", "body_family": "Microsoft YaHei", "emphasis_family": "Georgia", "code_family": "Consolas", "body_size": 22}',
    "images": '{"strategy": "ai_generated", "style": "corporate photography, clean backgrounds", "count": 5}',
}

_REC_SUFFIX_TEMPLATE = (
    "\n\nAfter your analysis, output a structured recommendation on a single line:\n"
    "<<RECOMMENDATION>>{example}<<END>>\n"
    "Use the exact keys shown above for this gate. JSON only — no markdown, no explanation inside the block."
)

# Append the tag-block suffix to each gate prompt at module load time.
for _gate, _example in _GATE_REC_EXAMPLES.items():
    GATE_PROMPTS[_gate] = GATE_PROMPTS[_gate] + _REC_SUFFIX_TEMPLATE.format(example=_example)


def build_gate_8_prompt() -> str:
    """Compose the Gate 8 prompt with optional rendering/palette catalog summaries.

    When the index files are present (PPT-Master clone available), we append
    them so the LLM can recommend deck_rendering / deck_palette grounded in
    the actual catalog. When absent (test environments or stripped installs),
    we fall back to the static AI/Web/User/Placeholder prompt.
    """
    base = GATE_PROMPTS["images"]
    rendering_catalog = load_rendering_index_summary()
    palette_catalog = load_palette_index_summary()

    if not rendering_catalog and not palette_catalog:
        return base

    extension = (
        "\n\n---\n\n"
        "**Additionally, recommend a deck-wide rendering style and palette behavior** "
        "from the catalogs below. These two values must apply to ALL AI images in the deck.\n\n"
        "### Rendering catalog (pick ONE `deck_rendering`)\n"
        f"{rendering_catalog}\n\n"
        "### Palette catalog (pick ONE `deck_palette`)\n"
        f"{palette_catalog}\n\n"
        "Include them in your `<<RECOMMENDATION>>` JSON as `deck_rendering` and `deck_palette` "
        "(string values matching a name from the catalogs above)."
    )
    return base + extension


def build_strategist_subgraph() -> StateGraph:
    """Build the Strategist subgraph with 8 interrupt gates + finalize node."""

    builder = StateGraph(PPTMasterState)

    builder.add_node("strategist_entry", _strategist_entry)

    for gate in EIGHT_GATES:
        if gate == "page_count":
            builder.add_node("gate_page_count", _gate_page_count_node())
        else:
            builder.add_node(f"gate_{gate}", _make_gate_node(gate))
        builder.add_node(f"refine_{gate}", _make_refine_node(gate))

    builder.add_node("strategist_finalize", _strategist_finalize)
    builder.add_node("strategist_done", _strategist_done)

    builder.set_entry_point("strategist_entry")
    builder.add_edge("strategist_entry", "gate_canvas")
    builder.add_edge("gate_canvas", "refine_canvas")

    prev_refine = "refine_canvas"
    for gate in EIGHT_GATES[1:]:
        builder.add_edge(prev_refine, f"gate_{gate}")
        builder.add_edge(f"gate_{gate}", f"refine_{gate}")
        prev_refine = f"refine_{gate}"

    builder.add_node("compute_ai_page_count", _compute_ai_page_count)
    builder.add_edge("refine_images", "compute_ai_page_count")
    builder.add_edge("compute_ai_page_count", "strategist_finalize")
    builder.add_edge("strategist_finalize", "strategist_done")

    return builder


def _make_gate_node(gate_name: str):
    """Create an interrupt gate node. Pauses for user confirmation."""

    async def gate_node(state: PPTMasterState) -> dict[str, Any]:
        progress = dict(state.get("confirmation_progress", {}))

        if progress.get(gate_name) == "approved":
            return {
                "current_step": 4,
                "confirmation_progress": progress,
            }

        # Generate a per-gate AI recommendation via a short LLM call.
        # Failure is silently caught — the gate proceeds without a recommendation.
        # TODO(G2): the per-gate recommendation call adds ~500ms-2s of latency.
        # Fold this into the existing strategist conversation chain instead of
        # making a separate cold invocation per gate.
        rec: dict[str, Any] | None = None
        try:
            model = await get_chat_model("strategist")
            gate_prompt = (
                build_gate_8_prompt()
                if gate_name == "images"
                else GATE_PROMPTS.get(gate_name, "")
            )

            # Build context from source content + user brief (max ~3000 chars)
            source_text = _load_source_excerpt(state.get("converted_markdown", []), 1500)
            user_brief = state.get("user_brief", "")
            outline = state.get("outline")
            outline_text = ""
            if isinstance(outline, dict):
                pages = outline.get("pages", [])
                outline_text = "\n".join(
                    f"- {p.get('index','?')}. [{p.get('type','content')}] {p.get('title','')}"
                    for p in pages[:15]
                )

            context_parts = []
            if user_brief:
                context_parts.append(f"Project brief: {user_brief[:500]}")
            if source_text:
                context_parts.append(f"Source content:\n{source_text}")
            if outline_text:
                context_parts.append(f"Page outline:\n{outline_text[:800]}")

            invoke_prompt = "\n\n".join(context_parts) + f"\n\nGate task:\n{gate_prompt}"
            llm_response = await model.ainvoke(invoke_prompt)
            raw_content = str(llm_response.content) if hasattr(llm_response, "content") else str(llm_response)
            _, rec = _extract_recommendation(raw_content)
        except Exception as e:
            logger.debug(f"Gate {gate_name} recommendation LLM call failed (non-fatal): {e}")
            rec = None

        pending_feedback: str | None = None

        while True:
            response = interrupt(_build_gate_interrupt_payload(gate_name, pending_feedback, recommendation=rec))

            # Allow user to go back to previous gate without feedback
            if _response_is_go_back(response):
                pending_feedback = None
                continue

            if _response_is_approval(response):
                progress[gate_name] = "approved"
                result: dict[str, Any] = {
                    "confirmation_progress": progress,
                    "current_step": 4,
                }
                # Persist the Gate 8 recommendation so _strategist_finalize can
                # inject deck_rendering / deck_palette into spec_lock.md.
                if gate_name == "images" and rec is not None:
                    result["images_recommendation"] = rec
                return result

            pending_feedback = _extract_feedback(response)

    return gate_node


def _gate_page_count_node():
    """Specialized page_count gate. Records page_count_mode + page_count in state.

    Schema:
        answers.page_count_mode: "explicit" | "ai_decide" (required for new frontend)
        answers.page_count: int (required when mode == "explicit")
        answer: numeric string (backward-compat — old frontend without mode field)
    """

    async def node(state: PPTMasterState) -> dict[str, Any]:
        progress = dict(state.get("confirmation_progress", {}))
        if progress.get("page_count") == "approved":
            return {"current_step": 4, "confirmation_progress": progress}

        # Generate per-gate AI recommendation.
        rec: dict[str, Any] | None = None
        try:
            model = await get_chat_model("strategist")
            gate_prompt = GATE_PROMPTS.get("page_count", "")

            source_text = _load_source_excerpt(state.get("converted_markdown", []), 2000)
            user_brief = state.get("user_brief", "")

            context_parts = []
            if user_brief:
                context_parts.append(f"Project brief: {user_brief[:500]}")
            if source_text:
                context_parts.append(f"Source content:\n{source_text}")

            invoke_prompt = "\n\n".join(context_parts) + f"\n\nGate task:\n{gate_prompt}"
            llm_response = await model.ainvoke(invoke_prompt)
            raw_content = str(llm_response.content) if hasattr(llm_response, "content") else str(llm_response)
            _, rec = _extract_recommendation(raw_content)
        except Exception as e:
            logger.debug(f"Gate page_count recommendation LLM call failed (non-fatal): {e}")
            rec = None

        pending_feedback: str | None = None

        while True:
            response = interrupt(_build_gate_interrupt_payload("page_count", pending_feedback, recommendation=rec))

            if _response_is_go_back(response):
                pending_feedback = None
                continue

            answers: dict[str, Any] = {}
            if isinstance(response, dict):
                raw_answers = response.get("answers")
                if isinstance(raw_answers, dict):
                    answers = raw_answers

            mode = answers.get("page_count_mode")

            # Backward-compat: old frontend / resumed legacy session sends a numeric
            # `answer` without `page_count_mode`. Treat it as explicit.
            if mode is None and _response_is_approval(response):
                raw_answer = response.get("answer") if isinstance(response, dict) else None
                try:
                    coerced = int(str(raw_answer).strip())
                    if 3 <= coerced <= 100:
                        mode = "explicit"
                        answers = {**answers, "page_count": coerced}
                    else:
                        pending_feedback = "Page count must be between 3 and 100."
                        continue
                except (TypeError, ValueError):
                    pass

            if _response_is_approval(response) and mode in {"explicit", "ai_decide"}:
                progress["page_count"] = "approved"
                update: dict[str, Any] = {
                    "confirmation_progress": progress,
                    "current_step": 4,
                    "page_count_mode": mode,
                }
                if mode == "explicit":
                    try:
                        value = int(answers.get("page_count"))
                    except (TypeError, ValueError):
                        pending_feedback = "Page count must be an integer between 3 and 100."
                        continue
                    if not (3 <= value <= 100):
                        pending_feedback = "Page count must be between 3 and 100."
                        continue
                    update["page_count"] = value
                else:
                    update["page_count"] = None
                return update

            pending_feedback = _extract_feedback(response)

    return node


def _make_refine_node(gate_name: str):
    """Optional refinement after gate approval."""

    async def refine_node(state: PPTMasterState) -> dict[str, Any]:
        messages = state.get("messages", [])
        return {
            "current_step": 4,
            "messages": messages + [
                {"role": "assistant", "content": f"OK, {gate_name.replace('_', ' ')} confirmed."}
            ],
        }

    return refine_node


async def _strategist_entry(state: PPTMasterState) -> dict[str, Any]:
    """Entry point for the strategist. Gathers context, reads sources, starts design."""

    model = await get_chat_model("strategist")

    layouts = list_layouts().get("layouts", {})

    # --- Load source content via chunker ---
    from pptmaster.agent.tools.source_chunker import chunk_sources

    converted = state.get("converted_markdown", [])
    chunked = chunk_sources(converted) if converted else None

    source_content = ""
    if chunked and chunked.chunks:
        source_content = f"## Source Index\n{chunked.index}\n\n"
        # Include first 3 chunks for overview understanding
        for c in chunked.chunks[:3]:
            source_content += f"### Chunk {c.index}: {c.title}\n{c.text}\n\n"
        if len(chunked.chunks) > 3:
            source_content += f"... ({len(chunked.chunks) - 3} more chunks — see index above for full structure)\n"
    elif not converted:
        source_content = "(No source files provided. Use the project brief and context to design the presentation.)"
    else:
        source_content = "(Source files could not be read.)"

    # --- User brief ---
    user_brief = state.get("user_brief", "")
    brief_section = ""
    if user_brief.strip():
        brief_section = (
            "\n## User Requirements (from Project Brief)\n"
            f"{user_brief}\n\n"
            "These requirements MUST influence all downstream design recommendations.\n"
        )

    template_mode = state.get("template_mode", "free_design")
    template_ctx = (
        "Free design — no template constraints."
        if template_mode == "free_design"
        else f"Template loaded: {state.get('template_path', 'unknown')} (kind={template_mode})"
    )

    context = {
        "project_id": state.get("project_id"),
        "source_file_count": len(converted),
        "available_layouts": list(layouts.keys()),
        "template_mode": template_mode,
    }

    prompt = f"""You are a presentation strategist. Create a design plan for a PPT deck.

Project context: {json.dumps(context, indent=2)}
{template_ctx}
{brief_section}
Available layouts: {', '.join(context['available_layouts'])}
Gates to address (in order): {', '.join(EIGHT_GATES)}

## Source Materials
{source_content if source_content else "(No source files provided. Use the project brief and context to design the presentation.)"}

## OVERRIDING RULE — Respect User Intent
If the user's prompt or source document specifies a page count, page division, or page outline
(e.g., headings like '第1页', 'Page 1', '## 第N页'), you MUST follow it exactly.
Do NOT add, remove, merge, or reorganize pages. The user's page structure is authoritative.

Analyze the source materials above carefully. For each gate, present a specific recommendation
grounded in the actual content — not a vague suggestion. Consider:
- The document's structure (chapters, sections, data points)
- Natural page breaks based on topic transitions
- Which pages would benefit from charts, images, or special layouts
- The target audience implied by the content

Respond conversationally. Be concise but concrete."""

    try:
        response = await model.ainvoke(prompt)
        content = response.content if hasattr(response, "content") else str(response)
    except Exception as e:
        logger.warning(f"Strategist LLM call failed: {e}")
        content = (
            "I'll design your presentation. "
            "Let's start with the first confirmation: canvas format."
        )

    return {
        "current_step": 4,
        "messages": state.get("messages", []) + [{"role": "assistant", "content": content}],
    }


async def _compute_ai_page_count(state: PPTMasterState) -> dict[str, Any]:
    """If user chose 'ai_decide' at gate_page_count, compute a recommended page count.
    Otherwise no-op. The result is written into state.page_count + .page_count_reasoning,
    which strategist_finalize reads as authoritative."""

    if state.get("page_count_mode") != "ai_decide":
        return {"current_step": 4}

    if state.get("page_count") is not None:
        # User override (came back through preflight); skip recompute.
        return {"current_step": 4}

    converted = state.get("converted_markdown", [])

    from pptmaster.agent.tools.source_chunker import chunk_sources
    chunked = chunk_sources(converted) if converted else None

    # Pre-divided source → chunk count is authoritative; no LLM needed.
    if chunked and chunked.index.source_type == "pre_divided" and chunked.index.total_chunks > 0:
        n = chunked.index.total_chunks
        return {
            "current_step": 4,
            "page_count": n,
            "page_count_reasoning": (
                f"Source document has {n} pre-divided page sections "
                f"(detected '第N页' / 'Page N' markers). Honoring the source structure."
            ),
        }

    # LLM-driven path
    source_summary = ""
    if chunked and chunked.chunks:
        source_summary = f"## Source Index\n{chunked.index}\n\n"
        for c in chunked.chunks:
            source_summary += f"### Chunk {c.index}: {c.title}\n{c.text[:1500]}\n\n"
    else:
        source_summary = "(No source files provided.)"

    user_brief = state.get("user_brief", "")
    messages = state.get("messages", [])
    gate_summary = "\n".join(
        f"- {m.get('content', '')[:300]}"
        for m in messages
        if m.get("role") == "assistant"
    )

    prompt = f"""You are a presentation strategist. Decide the optimal page count for this deck.

## User Brief
{user_brief or "(none)"}

## Confirmed Design Decisions (gates 1, 3-8)
{gate_summary}

## Source Materials
{source_summary}

## Task
Output exactly ONE JSON object on a single line, no markdown, no explanation:
{{"count": <integer between 3 and 100>, "reasoning": "<1-2 sentences citing specific source structure>"}}

Consider:
- Natural topic boundaries in the source
- Density per page consistent with the typography body size confirmed in gate 7
- Cover + ToC + conclusion pages if appropriate to the audience confirmed in gate 3
- Whether the user brief specifies a target length
"""

    model = await get_chat_model("strategist")
    count: int | None = None
    reasoning = ""
    try:
        response = await model.ainvoke(prompt)
        content = response.content if hasattr(response, "content") else str(response)
        # Strip markdown code fences if present
        text = content.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            text = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
            text = text.strip()
        # If LLM still emitted multiple lines (whitespace, etc), use the last non-empty
        last_line = next(
            (line for line in reversed(text.splitlines()) if line.strip().startswith("{")),
            text,
        )
        data = json.loads(last_line)
        count = int(data["count"])
        reasoning = str(data.get("reasoning", "")).strip()
        if not (3 <= count <= 100):
            count = None
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as e:
        logger.warning(f"compute_ai_page_count LLM parse failed: {e}")

    if count is None:
        # Fallback 1: scan source markdown for explicit page markers
        fallback = _count_pages_in_sources(converted)
        if fallback > 0:
            count = fallback
            reasoning = (
                f"AI determination failed; fell back to {fallback} pages from source page markers."
            )
        else:
            # Fallback 2: heuristic from chunk count
            chunk_count = len(chunked.chunks) if (chunked and chunked.chunks) else 0
            base = round(chunk_count / 1.5) if chunk_count else 10
            count = max(5, min(30, base or 10))
            reasoning = (
                f"AI determination failed and no page markers detected; "
                f"using heuristic from {chunk_count} source chunks."
            )

    return {
        "current_step": 4,
        "page_count": count,
        "page_count_reasoning": reasoning,
    }


def _write_spec_lock_images(rec: dict) -> str:
    """Render the `images:` YAML block for spec_lock.md.

    Optional fields (deck_rendering, deck_palette) are emitted only when
    present in the recommendation, so older recommendations remain backward
    compatible.
    """
    lines = ["images:"]
    if "strategy" in rec:
        lines.append(f"  strategy: {rec['strategy']}")
    if "deck_rendering" in rec:
        lines.append(f"  deck_rendering: {rec['deck_rendering']}")
    if "deck_palette" in rec:
        lines.append(f"  deck_palette: {rec['deck_palette']}")
    if "count" in rec:
        lines.append(f"  count: {rec['count']}")
    return "\n".join(lines) + "\n"


async def _strategist_finalize(state: PPTMasterState) -> dict[str, Any]:
    """After all 8 gates are approved, generate design_spec.md, spec_lock.md, and outline.json."""

    project_id = state.get("project_id", "unknown")
    model = await get_chat_model("strategist")

    messages = state.get("messages", [])
    gate_summary = "\n".join(
        f"- {m.get('content', '')[:500]}"
        for m in messages
        if m.get("role") == "assistant"
    )

    converted = state.get("converted_markdown", [])

    from pptmaster.agent.tools.source_chunker import chunk_sources
    chunked = chunk_sources(converted) if converted else None

    source_summary = ""
    if chunked and chunked.chunks:
        source_summary = f"## Source Index\n{chunked.index}\n\n"
        # Include ALL chunks for accurate outline generation
        for c in chunked.chunks:
            source_summary += f"### Chunk {c.index}: {c.title}\n{c.text}\n\n"
    else:
        source_summary = "(No source files)"

    base_path = f"{get_settings().storage_root}/projects/{project_id}"
    Path(base_path).mkdir(parents=True, exist_ok=True)

    target_page_count = state.get("page_count")

    prompt = f"""You are a presentation strategist finalizing the design plan.

The following 8 confirmations have been approved by the user:
{gate_summary}

Project: {project_id}
User brief: {state.get('user_brief', '')}
Confirmation status: {json.dumps(state.get('confirmation_progress', {}))}
Target page count: {target_page_count}  # AUTHORITATIVE — outline.json must have exactly this many entries
Page count rationale: {state.get('page_count_reasoning') or 'User specified directly.'}

## Source Materials
{source_summary if source_summary else "(No source files)"}

## OVERRIDING RULE — Respect User Intent
If the user's prompt or source document specifies a page count, page division, or page outline
(e.g., headings like '第1页', 'Page 1', '## 第N页'), you MUST reproduce it exactly in all three
output files. Do NOT add, remove, merge, or reorganize pages. The user's page structure is
authoritative and must be preserved verbatim.

## OVERRIDING RULE — Target Page Count
The outline MUST have EXACTLY {target_page_count} entries.
§IX of design_spec.md MUST have EXACTLY {target_page_count} page entries.
spec_lock.md page_rhythm MUST cover EXACTLY {target_page_count} pages.

Generate THREE files using the exact separator markers shown below.
Do NOT include any explanatory text outside the markers.

===DESIGN_SPEC===
(Write the full design_spec.md following the 11-section structure.
§IX Outline MUST have one entry per page matching the source document's page division exactly.
If the source has N pages (e.g., 第1页 through 第N页), §IX MUST have exactly N entries.
No blank page content. Every section filled with approved values.)

===SPEC_LOCK===
(Write spec_lock.md. ## data sections only: canvas, colors, typography, icons, images,
page_rhythm, page_layouts, page_charts. Every value must match confirmed decisions.
Use exact HEX, font stacks, and icon names approved by the user. No guidance text.)

===OUTLINE_JSON===
(Wrap in ```json block. The "pages" array MUST have exactly as many entries as the source
document's page division. If the source has 20 pages, the array MUST have 20 objects.
Each page MUST have index, name, title, subtitle, type,
layout_basename, rhythm, chart_basename, AND a content array with 2-5 detailed bullet
points from source materials — complete sentences, not labels. Never empty [].)
"""

    try:
        response = await model.ainvoke(prompt)
        content = response.content if hasattr(response, "content") else str(response)
    except Exception as e:
        logger.warning(f"Strategist finalize LLM call failed: {e}")
        return {
            "current_step": 4,
            "completed_steps": state.get("completed_steps", []) + [4],
            "messages": state.get("messages", []) + [
                {"role": "assistant", "content": f"Design spec generation failed: {e}"}
            ],
        }

    design_spec = ""
    spec_lock = ""
    outline_json = ""

    parts = content.split("===DESIGN_SPEC===")
    if len(parts) > 1:
        after_ds = parts[1].split("===SPEC_LOCK===")
        design_spec = after_ds[0].strip()
        if len(after_ds) > 1:
            after_sl = after_ds[1].split("===OUTLINE_JSON===")
            spec_lock = after_sl[0].strip()
            if len(after_sl) > 1:
                outline_json = after_sl[1].strip()

    # Patch the `images:` section of spec_lock with the Gate 8 recommendation
    # so deck_rendering / deck_palette are always written, even when the LLM
    # omits them or uses a different field name.
    images_rec = state.get("images_recommendation")
    if images_rec and spec_lock:
        images_block = _write_spec_lock_images(images_rec)
        # Replace any existing `images:` section (everything from `## images` or
        # `images:` to the next `##` section header or end of string).
        spec_lock = re.sub(
            r"(^|\n)images:.*?(?=\n##|\Z)",
            lambda m: (m.group(1) or "") + images_block.rstrip("\n"),
            spec_lock,
            flags=re.DOTALL,
        )
        # If no images: section existed in the LLM output, append it.
        if "images:" not in spec_lock:
            spec_lock = spec_lock.rstrip() + "\n" + images_block

    design_spec_path = Path(base_path) / "design_spec.md"
    spec_lock_path = Path(base_path) / "spec_lock.md"
    outline_path = Path(base_path) / "outline.json"

    design_spec_path.write_text(design_spec or "# Design Spec\n\nGeneration incomplete.", encoding="utf-8")
    spec_lock_path.write_text(
        spec_lock or "## canvas\n- viewBox: 0 0 1280 720\n- format: PPT 16:9\n",
        encoding="utf-8",
    )

    # Strip markdown code fences if present (LLM often wraps in ```json ... ```)
    outline_json_clean = outline_json.strip()
    if outline_json_clean.startswith("```"):
        first_newline = outline_json_clean.find("\n")
        if first_newline != -1:
            outline_json_clean = outline_json_clean[first_newline + 1:]
        if outline_json_clean.endswith("```"):
            outline_json_clean = outline_json_clean[:-3]
        outline_json_clean = outline_json_clean.strip()

    try:
        outline_data = json.loads(outline_json_clean)
    except json.JSONDecodeError as e:
        logger.warning(
            f"outline.json parse failed (len={len(outline_json_clean)}): {e}. "
            f"First 200 chars: {outline_json_clean[:200]}"
        )
        # Fallback: try to extract pages from design_spec.md §IX
        outline_data = _extract_outline_from_design_spec(design_spec, canvas_format="ppt169")
    # State.page_count is now the single authoritative target. Force the outline
    # to match it; if our extract fallbacks also fail to produce the right count,
    # _force_page_count() pads/truncates to guarantee the contract.
    if target_page_count is None:
        # Defensive: should not happen because compute_ai_page_count runs before us
        # for ai_decide mode, and explicit mode writes page_count at the gate.
        logger.warning("strategist_finalize: state.page_count is None; using outline as-is.")
        target_page_count = len(outline_data.get("pages", [])) or 1

    outline_pages = len(outline_data.get("pages", []))
    if outline_pages != target_page_count:
        logger.warning(
            f"Outline has {outline_pages} pages but state.page_count={target_page_count}. "
            f"Re-extracting from sources."
        )
        if converted:
            attempt = _extract_outline_from_sources(converted, canvas_format="ppt169")
            if len(attempt.get("pages", [])) == target_page_count:
                outline_data = attempt
            else:
                attempt = _extract_outline_from_design_spec(design_spec, canvas_format="ppt169")
                if len(attempt.get("pages", [])) == target_page_count:
                    outline_data = attempt
        outline_data = _force_page_count(outline_data, target_page_count)

    outline_path.write_text(json.dumps(outline_data, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "current_step": 4,
        "completed_steps": state.get("completed_steps", []) + [4],
        "design_spec_path": str(design_spec_path),
        "spec_lock_path": str(spec_lock_path),
        "outline_path": str(outline_path),
        "messages": state.get("messages", []) + [
            {"role": "assistant",
             "content": (
                 f"Design spec completed. All 8 confirmations approved. "
                 f"outline.json: {len(outline_data.get('pages', []))} pages. "
                 f"design_spec.md / spec_lock.md / outline.json written."
             )}
        ],
    }


async def _strategist_done(state: PPTMasterState) -> dict[str, Any]:
    """Finalize strategist work — mark complete."""

    return {
        "current_step": 4,
        "completed_steps": state.get("completed_steps", []) + [4],
        "messages": state.get("messages", []) + [
            {"role": "assistant",
             "content": "Design spec completed. All 8 confirmations approved. Ready for image generation."}
        ],
    }


def _count_pages_in_sources(converted_markdown: list[str]) -> int:
    """Count page divisions in source markdown files.

    Looks for headings like '## 第N页', '### 第N页', '## Page N', etc.
    Returns the maximum page index found, or 0 if no page divisions detected.
    """
    import re

    pattern = re.compile(r"^#{1,4}\s+(?:第(\d+)页|Page\s*(\d+))", re.MULTILINE)
    max_idx = 0

    for fpath in converted_markdown:
        try:
            text = Path(fpath).read_text(encoding="utf-8")
        except OSError:
            continue
        for m in pattern.finditer(text):
            idx_str = m.group(1) or m.group(2)
            if idx_str:
                max_idx = max(max_idx, int(idx_str))

    return max_idx


def _extract_outline_from_sources(converted_markdown: list[str], canvas_format: str = "ppt169") -> dict[str, Any]:
    """Build outline directly from source markdown files' page divisions.

    Used as a hard-fallback when the LLM's outline doesn't match the source page count.
    Handles common Chinese source patterns:
      - '## 第N页：正文页' where '正文页' is the page *type* (not a title).
      - Plain paragraph body content (not just markdown bullets).
      - '**故事线**' / '**正文内容**' field labels — the values become content.
    """
    import re

    canvas_map = {"ppt169": (1280, 720), "ppt43": (1024, 768)}
    w, h = canvas_map.get(canvas_format, (1280, 720))

    # Words that should be treated as a page *type* rather than a free-form title.
    TYPE_WORDS = {
        "cover": ("cover", "cover"),
        "封面": ("cover", "cover"),
        "首页": ("cover", "cover"),
        "end": ("end", "end"),
        "结尾": ("end", "end"),
        "结束": ("end", "end"),
        "thank": ("end", "end"),
        "谢谢": ("end", "end"),
        "致谢": ("end", "end"),
        "目录": ("toc", "toc"),
        "toc": ("toc", "toc"),
        "outline": ("toc", "toc"),
        "agenda": ("toc", "toc"),
        "正文页": ("content", None),
        "content": ("content", None),
        "章节": ("section", None),
        "section": ("section", None),
        "chapter": ("section", None),
    }

    pages: list[dict[str, Any]] = []
    page_pattern = re.compile(r"^#{1,4}\s+(?:第(\d+)页|Page\s*(\d+))[:：]?\s*(.+)?$", re.MULTILINE)

    for fpath in converted_markdown:
        try:
            text = Path(fpath).read_text(encoding="utf-8")
        except OSError:
            continue

        matches = list(page_pattern.finditer(text))
        for i, m in enumerate(matches):
            idx_str = m.group(1) or m.group(2)
            heading_tail = (m.group(3) or "").strip()
            idx = int(idx_str) if idx_str else len(pages) + 1

            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            section = text[start:end]

            # If the heading tail is just a type word, treat it as type, not title.
            page_type = "content"
            name = f"page_{idx:02d}"
            heading_tail_clean = heading_tail.strip("：: \t")
            title_from_heading = heading_tail
            for kw, (ptype, pname) in TYPE_WORDS.items():
                if kw in heading_tail_clean.lower():
                    page_type = ptype
                    if pname:
                        name = pname
                    elif ptype == "section":
                        name = f"section_{idx:02d}"
                    # The heading tail was a type marker, not a real title.
                    title_from_heading = ""
                    break

            # Pull "**故事线**" value, "**正文内容**" body, plain paragraphs, bullets.
            storyline = ""
            body_lines: list[str] = []
            mode = None  # None | "storyline" | "body"
            for line in section.split("\n"):
                stripped = line.strip()
                if not stripped:
                    mode = None
                    continue
                m_label = re.match(r"^\*\*([^*]+)\*\*[:：]\s*(.*)$", stripped)
                if m_label:
                    label = m_label.group(1).strip().lower()
                    value = m_label.group(2).strip()
                    if "故事线" in label or "storyline" in label or "story" in label:
                        # Strip bracketed prefix tags like "（基本情况）【概况】"
                        cleaned = re.sub(r"^[（(【\[][^）)】\]]*[）)】\]]\s*", "", value)
                        cleaned = re.sub(r"^[（(【\[][^）)】\]]*[）)】\]]\s*", "", cleaned)
                        storyline = cleaned.strip()
                        mode = "storyline"
                    elif "正文" in label or "body" in label or "content" in label:
                        if value:
                            body_lines.append(value)
                        mode = "body"
                    else:
                        mode = None
                    continue
                # Skip markdown table rows entirely
                if stripped.startswith("|"):
                    continue
                # Bullet lines
                if re.match(r"^[-*•]\s+", stripped):
                    cleaned = re.sub(r"^[-*•]\s+", "", stripped)
                    cleaned = re.sub(r"\*\*([^*]+)\*\*[:：]?\s*", "", cleaned)
                    if cleaned.strip():
                        body_lines.append(cleaned.strip())
                    continue
                # Sub-headings
                if re.match(r"^#{3,4}\s+", stripped):
                    cleaned = re.sub(r"^#{3,4}\s+", "", stripped)
                    cleaned = re.sub(r"\*\*([^*]+)\*\*[:：]?\s*", "", cleaned)
                    if cleaned.strip():
                        body_lines.append(cleaned.strip())
                    continue
                # Plain paragraph line — collect if we are inside body or have no label yet.
                if mode == "body" or mode is None:
                    body_lines.append(stripped)

            # Title resolution: prefer heading-tail title; otherwise storyline; otherwise first body sentence.
            title = title_from_heading
            if not title and storyline:
                title = storyline[:60]
            if not title and body_lines:
                first = body_lines[0]
                # Use first sentence up to ~40 chars
                sentence = re.split(r"[。.!?！？\n]", first, maxsplit=1)[0]
                title = sentence[:60]

            # Content points: prefer storyline first, then unique body paragraphs.
            seen: set[str] = set()
            content_points: list[str] = []
            if storyline:
                content_points.append(storyline)
                seen.add(storyline)
            for line in body_lines:
                # Trim very long lines to a reasonable bullet length
                snippet = line[:200]
                if snippet and snippet not in seen:
                    content_points.append(snippet)
                    seen.add(snippet)
                if len(content_points) >= 5:
                    break

            pages.append({
                "index": idx,
                "name": name,
                "title": title,
                "type": page_type,
                "layout_basename": None,
                "rhythm": "dense" if page_type == "content" else "anchor",
                "chart_basename": None,
                "content": content_points[:5] if content_points else [],
            })

    if not pages:
        pages = [{"index": 1, "name": "cover", "title": "Cover", "type": "cover",
                   "layout_basename": None, "rhythm": "anchor", "chart_basename": None, "content": []}]

    return {
        "canvas": {"format": canvas_format, "width": w, "height": h, "viewBox": f"0 0 {w} {h}"},
        "pages": pages,
    }


def _extract_outline_from_design_spec(design_spec: str, canvas_format: str = "ppt169") -> dict[str, Any]:
    """Fallback: parse page entries from design_spec.md §IX Outline section.

    Handles two LLM output formats:
      (a) Same-line:  '### Page 1: Title Here' followed by '- bullet' content lines
      (b) Multi-line: '### Page 1' followed by '- **Title:** X' / '- **Subtitle:** Y' /
          '- **Type:** Z' / '- **Content Bullets:**' + sub-bullets

    Falls back gracefully if a section is incomplete.
    """
    import re

    canvas_map = {
        "ppt169": (1280, 720),
        "ppt43": (1024, 768),
    }
    w, h = canvas_map.get(canvas_format, (1280, 720))

    pages: list[dict[str, Any]] = []
    # Match page headings (h2-h4): "### Page N", "### Page N: Title", "### 第N页", "### 第N页：Title"
    # Title on same line is optional.
    heading_re = re.compile(
        r"^(#{2,4})\s+(?:第(\d+)页|Page\s*(\d+))(?:\s*[:：]\s*(.+))?$",
        re.MULTILINE,
    )
    matches = list(heading_re.finditer(design_spec))

    def _strip_bullet(line: str) -> str:
        return re.sub(r"^[-*•]\s+", "", line.strip())

    def _field_value(line: str, field: str) -> str | None:
        """Match '- **Field:** value' or '- **Field**: value' (colon inside or outside
        the bold markers, Chinese or English colon). Returns value or None.
        """
        pat = re.compile(
            rf"^\s*[-*•]\s+\*\*\s*{re.escape(field)}\s*[:：]?\s*\*\*\s*[:：]?\s*(.+?)\s*$",
            re.IGNORECASE,
        )
        m = pat.match(line)
        return m.group(1).strip() if m else None

    for i, m in enumerate(matches):
        idx_str = m.group(2) or m.group(3)
        same_line_title = (m.group(4) or "").strip()
        idx = int(idx_str) if idx_str else len(pages) + 1

        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(design_spec)
        section_text = design_spec[start:end]
        lines = section_text.split("\n")

        # Field extraction from "- **Field:** value" bullets
        title = same_line_title
        subtitle = ""
        page_type_raw = ""
        layout_basename = None
        rhythm_raw = ""
        chart_basename = None

        # Locate "Content Bullets" header line (if present)
        content_header_idx: int | None = None
        for j, raw in enumerate(lines):
            stripped = raw.strip()
            if not stripped:
                continue
            v = _field_value(stripped, "Title")
            if v and not title:
                title = v
                continue
            v = _field_value(stripped, "Subtitle")
            if v:
                subtitle = v
                continue
            v = _field_value(stripped, "Type")
            if v:
                page_type_raw = v.lower()
                continue
            v = _field_value(stripped, "Layout Basename") or _field_value(stripped, "Layout")
            if v:
                layout_basename = v if v.lower() not in ("none", "null", "") else None
                continue
            v = _field_value(stripped, "Rhythm")
            if v:
                rhythm_raw = v.lower()
                continue
            v = _field_value(stripped, "Chart Basename") or _field_value(stripped, "Chart")
            if v:
                chart_basename = v if v.lower() not in ("none", "null", "") else None
                continue
            if re.match(
                r"^\s*[-*•]\s+\*\*\s*Content\s+Bullets\s*[:：]?\s*\*\*\s*[:：]?\s*$",
                raw, re.IGNORECASE,
            ):
                content_header_idx = j
                continue

        # Collect content bullets
        content_points: list[str] = []
        if content_header_idx is not None:
            # Take sub-bullets after the "Content Bullets" header
            for raw in lines[content_header_idx + 1 :]:
                if not raw.strip():
                    continue
                if re.match(r"^[-*•]\s+\*\*", raw.strip()):
                    # Hit the next top-level field bullet — stop
                    break
                if re.match(r"^\s*[-*•]\s+", raw):
                    text = _strip_bullet(raw)
                    if text:
                        content_points.append(text)
        else:
            # Same-line title format: any non-field bullet becomes content
            for raw in lines:
                stripped = raw.strip()
                if not stripped or not re.match(r"^[-*•]\s+", stripped):
                    continue
                if re.match(r"^[-*•]\s+\*\*[^*]+\*\*\s*[:：]?", stripped):
                    continue  # field bullet — skip
                text = _strip_bullet(stripped)
                if text:
                    content_points.append(text)

        # Determine page type — prefer explicit "Type:" field, fall back to title heuristics
        page_type = "content"
        name = f"page_{idx:02d}"
        type_source = (page_type_raw or title).lower()
        if any(kw in type_source for kw in ["cover", "封面", "首页"]):
            page_type, name = "cover", "cover"
        elif any(kw in type_source for kw in ["end", "结尾", "结束", "thank", "谢谢", "致谢"]):
            page_type, name = "end", "end"
        elif any(kw in type_source for kw in ["目录", "toc", "outline", "agenda"]):
            page_type, name = "toc", "toc"
        elif any(kw in type_source for kw in ["章节", "section", "chapter"]):
            page_type, name = "section", f"section_{idx:02d}"

        page_obj: dict[str, Any] = {
            "index": idx,
            "name": name,
            "title": title or f"Page {idx}",
            "type": page_type,
            "layout_basename": layout_basename,
            "rhythm": rhythm_raw or ("dense" if page_type == "content" else "anchor"),
            "chart_basename": chart_basename,
            "content": content_points[:5],
        }
        if subtitle:
            page_obj["subtitle"] = subtitle
        pages.append(page_obj)

    if not pages:
        logger.warning("Could not extract any pages from design_spec.md §IX")
        pages = [{"index": 1, "name": "cover", "title": "Cover", "type": "cover",
                   "layout_basename": None, "rhythm": "anchor", "chart_basename": None, "content": []}]

    return {
        "canvas": {"format": canvas_format, "width": w, "height": h,
                    "viewBox": f"0 0 {w} {h}"},
        "pages": pages,
    }


def _force_page_count(outline_data: dict[str, Any], target: int) -> dict[str, Any]:
    """Make outline_data['pages'] have exactly `target` entries.

    Truncate when too long. Pad with placeholder content pages when too short.
    Caller is responsible for downstream consumers (executor) tolerating
    placeholder pages; user always has a chance to revise in Preflight Review.
    """
    pages = list(outline_data.get("pages", []))

    if len(pages) > target:
        pages = pages[:target]
    else:
        next_idx = (pages[-1]["index"] + 1) if pages else 1
        while len(pages) < target:
            pages.append({
                "index": next_idx,
                "name": f"page_{next_idx:02d}",
                "title": f"Page {next_idx}",
                "type": "content",
                "layout_basename": None,
                "rhythm": "dense",
                "chart_basename": None,
                "content": [],
            })
            next_idx += 1

    return {**outline_data, "pages": pages}


def _response_is_go_back(response: Any) -> bool:
    if isinstance(response, dict):
        decision = response.get("decision") or response.get("answer", "")
        if isinstance(decision, list):
            decision = decision[0] if decision else ""
        return str(decision).strip().lower() == "go_back"
    if isinstance(response, str):
        return response.strip().lower() == "go_back"
    return False


def _is_approval(text: str) -> bool:
    text_lower = text.lower().strip()
    approvals = ["yes", "ok", "okay", "approved", "approve", "确认", "好的", "可以", "没问题",
                 "looks good", "lgtm", "go ahead", "proceed", "继续", "同意"]
    for a in approvals:
        if a in text_lower:
            return True
    if text_lower in ["y", "yes.", "ok.", "ok!"]:
        return True
    return False


def _build_gate_interrupt_payload(
    gate_name: str,
    feedback: str | None = None,
    recommendation: dict | None = None,
) -> dict[str, Any]:
    title = GATE_TITLES[gate_name]
    base_prompt = GATE_PROMPTS.get(gate_name, f"Please review and approve: {title}.")
    prompt = base_prompt
    if feedback:
        prompt = f"{base_prompt}\n\nLatest feedback: {feedback}"

    return {
        "gate": gate_name,
        "prompt": prompt,
        "recommendation": recommendation,
        "question_form": {
            "id": f"gate_{gate_name}",
            "title": title,
            "questions": [
                {
                    "id": "decision",
                    "type": "radio",
                    "label": f"Approve {title}?",
                    "required": True,
                    "options": [
                        {"value": "approve", "label": "Approve and continue"},
                        {"value": "revise", "label": "Need revisions"},
                    ],
                }
            ],
        },
    }


def _response_is_approval(response: Any) -> bool:
    answers = []

    if isinstance(response, dict):
        raw_answers = response.get("answers")
        if isinstance(raw_answers, dict):
            decision = raw_answers.get("decision")
            if isinstance(decision, list):
                answers.extend(str(value) for value in decision)
            elif decision is not None:
                answers.append(str(decision))

        answer_text = response.get("answer")
        if answer_text is not None:
            answers.append(str(answer_text))
    elif response is not None:
        answers.append(str(response))

    return any(_is_approval(answer) or answer.strip().lower() == "approve" for answer in answers)


def _extract_feedback(response: Any) -> str | None:
    if isinstance(response, dict):
        answer_text = response.get("answer")
        if isinstance(answer_text, str) and answer_text.strip():
            return answer_text.strip()

        raw_answers = response.get("answers")
        if isinstance(raw_answers, dict):
            decision = raw_answers.get("decision")
            if isinstance(decision, str) and decision.strip() and decision.strip().lower() != "approve":
                return decision.strip()
            if isinstance(decision, list):
                joined = ", ".join(str(value).strip() for value in decision if str(value).strip())
                if joined and joined.lower() != "approve":
                    return joined

    if isinstance(response, str) and response.strip():
        return response.strip()

    return None
