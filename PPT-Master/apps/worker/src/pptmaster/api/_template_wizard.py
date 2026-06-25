"""Template wizard helpers — field extraction, prompt building, asset saving.

Provides the per-kind field schemas, manifest field extraction, Template_Designer
LLM prompt construction, and template asset persistence.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# ── Per-kind field schemas ──────────────────────────────────────────────────

DECK_FIELDS = {
    "template_id": "str", "name": "str", "summary": "str",
    "canvas_format": "str", "primary_color": "str",
    "colors": "dict",
    "typography": "dict",
    "logo": "dict | None",
    "page_count": "int", "page_types": "list[str]",
    "image_strategy": "str | None", "voice_tone": "str | None",
}

LAYOUT_FIELDS = {
    "template_id": "str", "name": "str", "summary": "str",
    "canvas_format": "str",
    "page_count": "int", "page_types": "list[str]",
}

BRAND_FIELDS = {
    "template_id": "str", "name": "str", "summary": "str",
    "primary_color": "str",
    "colors": "dict",
    "typography": "dict",
    "logo": "dict | None",
    "voice_tone": "str | None",
}

FIELD_PROVENANCE: dict[str, str] = {
    "template_id": "事实",
    "name": "事实",
    "summary": "推测",
    "canvas_format": "事实",
    "primary_color": "事实",
    "colors": "事实",
    "typography": "推测",
    "logo": "事实",
    "page_count": "事实",
    "page_types": "推测",
    "image_strategy": "需决定",
    "voice_tone": "需决定",
}


# ── Manifest field extraction ───────────────────────────────────────────────


def extract_manifest_fields(manifest: dict[str, Any], kind: str) -> dict[str, Any]:
    """Pull relevant fields from the pptx_template_import manifest for a given kind.

    Returns a dict with field_name -> {value, provenance, auto_detected}.
    """
    result: dict[str, dict[str, Any]] = {}

    # -- Slide size → canvas_format
    slide_size = manifest.get("slideSize", {})
    width = slide_size.get("width", 0)
    height = slide_size.get("height", 0)
    canvas = _derive_canvas_format(width, height)
    result["canvas_format"] = {
        "value": canvas,
        "provenance": "事实",
        "auto_detected": True,
    }

    # -- Theme colors
    theme = manifest.get("theme", {})
    theme_colors = theme.get("colors", {})
    primary = _extract_primary_color(theme_colors)
    if primary:
        result["primary_color"] = {
            "value": primary,
            "provenance": "事实",
            "auto_detected": True,
        }

    # Build color scheme dict (up to 6 roles)
    color_roles = [
        ("dk1", "dark1"), ("lt1", "light1"),
        ("dk2", "dark2"), ("lt2", "light2"),
        ("accent1", "accent1"), ("accent2", "accent2"),
    ]
    colors: dict[str, str] = {}
    for short, long in color_roles:
        hex_val = theme_colors.get(short) or theme_colors.get(long)
        if hex_val and isinstance(hex_val, str) and hex_val.startswith("#"):
            colors[long] = hex_val.upper()
    if colors:
        result["colors"] = {
            "value": colors,
            "provenance": "事实",
            "auto_detected": True,
        }

    # -- Fonts
    fonts = theme.get("fonts", {})
    typography = _extract_typography(fonts)
    if typography:
        result["typography"] = {
            "value": typography,
            "provenance": "推测",
            "auto_detected": True,
        }

    # -- Logo
    assets = manifest.get("assets", {})
    logo = _extract_logo_from_manifest(assets, manifest)
    if logo:
        result["logo"] = {
            "value": logo,
            "provenance": "事实",
            "auto_detected": True,
        }

    # -- Slides
    slides = manifest.get("slides", [])
    result["page_count"] = {
        "value": len(slides),
        "provenance": "事实",
        "auto_detected": True,
    }

    # -- Page types (derived from slide/layout names)
    page_types = _derive_page_types(manifest, slides)
    if page_types:
        result["page_types"] = {
            "value": page_types,
            "provenance": "推测",
            "auto_detected": True,
        }

    # -- Template ID auto-suggestion (not from manifest, caller provides)
    result["template_id"] = {
        "value": "",
        "provenance": "事实",
        "auto_detected": False,
    }
    result["name"] = {
        "value": "",
        "provenance": "事实",
        "auto_detected": False,
    }
    result["summary"] = {
        "value": _generate_summary(manifest, kind),
        "provenance": "推测",
        "auto_detected": True,
    }

    # -- Kind-specific defaults
    if kind in ("deck", "brand"):
        result["voice_tone"] = {
            "value": "",
            "provenance": "需决定",
            "auto_detected": False,
        }
    if kind == "deck":
        result["image_strategy"] = {
            "value": "",
            "provenance": "需决定",
            "auto_detected": False,
        }

    # Filter to kind-specific fields
    kind_fields = {
        "deck": DECK_FIELDS,
        "layout": LAYOUT_FIELDS,
        "brand": BRAND_FIELDS,
    }.get(kind, DECK_FIELDS)

    return {k: v for k, v in result.items() if k in kind_fields}


def _derive_canvas_format(width: int, height: int) -> str:
    """Map slide dimensions to a known canvas format string."""
    ratio = width / height if height else 0
    # 16:9 = 1.778; 4:3 = 1.333
    if abs(ratio - (16 / 9)) < 0.05:
        return "ppt169"
    elif abs(ratio - (4 / 3)) < 0.05:
        return "ppt43"
    elif abs(ratio - (297 / 210)) < 0.05:  # A4 landscape
        return "a4l"
    # PPT default 16:9 in EMU: 12192000 x 6858000
    if width > 10000000 and height > 5000000:
        return "ppt169"
    return "ppt169"


def _extract_primary_color(theme_colors: dict[str, Any]) -> str | None:
    """Find the first accent or dark2 color that looks like a primary."""
    # Try accent1 first (usually the brand's primary color)
    candidates = ["accent1", "dk2", "dark2", "accent2"]
    for key in candidates:
        val = theme_colors.get(key) or theme_colors.get(
            list(theme_colors.keys())[0] if theme_colors else ""
        )
    for key in candidates:
        val = theme_colors.get(key)
        if val and isinstance(val, str) and val.startswith("#"):
            return val.upper()
    # Take the first hex value available
    for v in theme_colors.values():
        if isinstance(v, str) and v.startswith("#"):
            return v.upper()
    return None


def _extract_typography(fonts: dict[str, Any]) -> dict[str, Any] | None:
    """Extract font families and body size from manifest fonts dict."""
    if not fonts:
        return None

    result: dict[str, str] = {}
    # Common keys in pptx_template_import manifest
    for manifest_key, label in [
        ("title", "title_family"),
        ("body", "body_family"),
        ("emphasis", "emphasis_family"),
        ("code", "code_family"),
        ("bodySize", "body_size"),
    ]:
        val = fonts.get(manifest_key)
        if val:
            result[label] = val

    return result if result else None


def _extract_logo_from_manifest(assets: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any] | None:
    """Detect a logo from manifest assets."""
    all_assets = assets.get("allAssets", [])
    common = assets.get("commonAssets", [])

    # Look for image assets with "logo" in the name
    logo_candidates = [
        a for a in (all_assets + common)
        if isinstance(a, dict) and "logo" in str(a.get("name", "")).lower()
    ]
    if logo_candidates:
        best = logo_candidates[0]
        return {
            "file": best.get("name", best.get("filename", "")),
            "placement": "左上角" if "top" in str(best.get("position", "")).lower() else "默认位置",
        }

    # Check theme colors for logo-related entries
    theme = manifest.get("theme", {})
    theme_logo = theme.get("logo")
    if theme_logo:
        return {"file": str(theme_logo), "placement": "默认位置"}

    return None


def _derive_page_types(manifest: dict[str, Any], slides: list[dict[str, Any]]) -> list[str]:
    """Derive canonical page types from manifest slide/layout data."""
    types: list[str] = []
    seen: set[str] = set()

    layouts = manifest.get("layouts", [])
    if layouts:
        for layout in layouts:
            name = layout.get("name", "") if isinstance(layout, dict) else str(layout)
            if not name:
                continue
            page_type = _layout_name_to_page_type(name)
            if page_type and page_type not in seen:
                seen.add(page_type)
                types.append(page_type)

    # If no layouts mapped, infer from slide count
    if not types and slides:
        count = len(slides)
        if count >= 1:
            types.append("cover")
        if count >= 3:
            types.append("toc")
        if count >= 4:
            types.append("chapter")
        if count >= 2:
            types.append("content")
        if count >= 2:
            types.append("ending")

    return types if types else ["cover", "toc", "content", "ending"]


_PAGE_TYPE_MAP = {
    "cover": "cover",
    "title": "cover",
    "title slide": "cover",
    "toc": "toc",
    "table of contents": "toc",
    "agenda": "toc",
    "chapter": "chapter",
    "section": "chapter",
    "divider": "chapter",
    "content": "content",
    "body": "content",
    "blank": "content",
    "ending": "ending",
    "closing": "ending",
    "thank you": "ending",
}


def _layout_name_to_page_type(name: str) -> str | None:
    name_lower = name.lower().strip()
    for key, ptype in _PAGE_TYPE_MAP.items():
        if key in name_lower:
            return ptype
    return None


def _generate_summary(manifest: dict[str, Any], kind: str) -> str:
    """Generate a reasonable summary line from the manifest."""
    kind_cn = {"deck": "演示文稿模板", "layout": "版面布局模板", "brand": "品牌规范模板"}.get(kind, "模板")
    slides = manifest.get("slides", [])
    page_count = len(slides)
    layouts = manifest.get("layouts", [])
    layout_count = len(layouts)

    parts = [kind_cn]
    if layout_count:
        parts.append(f"包含 {layout_count} 种版式")
    if page_count:
        parts.append(f"{page_count} 页参考幻灯片")

    theme = manifest.get("theme", {})
    theme_name = theme.get("name", "")
    if theme_name:
        parts.append(f"主题: {theme_name}")

    return "，".join(parts)


# ── Template_Designer prompt building ───────────────────────────────────────


def build_template_designer_prompt(
    kind: str,
    confirmed_fields: dict[str, Any],
    manifest: dict[str, Any] | None = None,
    svg_paths: list[str] | None = None,
) -> str:
    """Construct the Template_Designer LLM prompt from confirmed fields.

    The prompt instructs the LLM to produce:
    1. A design_spec.md with YAML frontmatter (all confirmed fields)
       and kind-appropriate markdown sections.
    2. Per-page SVGs matching the page type roster.
    """
    kind_display = {"deck": "Deck", "layout": "Layout", "brand": "Brand"}[kind]
    kind_dir = {"deck": "decks", "layout": "layouts", "brand": "brands"}[kind]

    prompt_parts: list[str] = []

    prompt_parts.append(f"""你是一个 {kind_display} 模板设计师（Template_Designer 角色）。
请根据以下已确认的字段，生成一个完整的 {kind_display} 模板。

## 模板元数据（已确认的字段）

""")

    for field, schema_type in DECK_FIELDS.items():
        val = confirmed_fields.get(field)
        if val is None or val == "":
            continue
        provenance = FIELD_PROVENANCE.get(field, "事实")
        if isinstance(val, dict):
            val_str = json.dumps(val, ensure_ascii=False)
        elif isinstance(val, list):
            val_str = json.dumps(val, ensure_ascii=False)
        else:
            val_str = str(val)
        prompt_parts.append(f"- **{field}** ({schema_type} / {provenance}): {val_str}")

    # Kind-specific section instructions
    if kind == "deck":
        prompt_parts.append("""
## 生成要求

### design_spec.md
必须包含 YAML frontmatter（含所有上述字段），以及以下 markdown 章节：
- I. Template Overview（使用场景、适用类型）
- II. Canvas（画布格式、页面尺寸）
- III. Color Scheme（颜色方案，6个角色：dark1/light1/dark2/light2/accent1/accent2）
- IV. Typography（字体层级：title/body/emphasis/code + body_size）
- V. Logo & Brand Assets（logo 文件、位置）
- VI. Layout Structure（页面类型及其用途）
- VII. Image Strategy（图片使用策略）
- VIII. Voice & Tone（语调和风格指南）
- IX. Page Roster（页面清单：01_cover, 02_toc, 02_chapter(可选), 03_content, 04_ending）

### SVG 页面
生成以下 SVG 页面（使用 viewBox="0 0 {width} {height}"）：
- 01_cover.svg — 封面页
- 02_toc.svg — 目录页
- 02_chapter.svg — 章节页（如适用）
- 03_content.svg — 内容页
- 04_ending.svg — 结束页

每页 SVG 必须符合 technical spec（无 forbidden elements，inline styles，PPT-safe fonts）。
所有 SVG 中的颜色、字体必须与上述字段一致。
""".replace("{width}", "768" if confirmed_fields.get("canvas_format") == "ppt43" else "960")
  .replace("{height}", "576" if confirmed_fields.get("canvas_format") == "ppt43" else "540"))

    elif kind == "layout":
        prompt_parts.append(f"""
## 生成要求

### design_spec.md
必须包含 YAML frontmatter（含所有上述字段），以及以下 markdown 章节：
- I. Template Overview（使用场景、适用类型）
- II. Canvas（画布格式、页面尺寸）
- III. Page Types & Structure（页面类型及其用途）
- IV. Page Roster（页面清单：{" ".join(confirmed_fields.get('page_types', ['01_cover', '02_toc', '03_content', '04_ending']))}）

注意：Layout 模板不包含颜色方案和字体定义（这些属于 Deck/Brand 的职责）。

### SVG 页面
为 Page Roster 中的每个页面类型生成对应的 SVG 页面。
viewBox="0 0 {960 if confirmed_fields.get('canvas_format') != 'ppt43' else 768} {540 if confirmed_fields.get('canvas_format') != 'ppt43' else 576}"
所有 SVG 必须符合 technical spec（无 forbidden elements，inline styles，PPT-safe fonts）。
""")

    elif kind == "brand":
        prompt_parts.append(f"""
## 生成要求

### design_spec.md
必须包含 YAML frontmatter（含所有上述字段），以及以下 markdown 章节：
- I. Brand Overview（品牌概述、使用场景）
- II. Color Scheme（颜色方案，6个角色）
- III. Typography（字体层级：title/body/emphasis/code + body_size）
- IV. Logo & Brand Assets（logo 文件、使用规范、安全距离）
- V. Voice & Tone（声音和语调指南）

注意：Brand 模板不包含页面结构定义（这些属于 Layout/Deck 的职责），也不需要生成 SVG 页面。

### 输出
只生成 design_spec.md。Brand 模板无 SVG 页面。
""")

    prompt_parts.append(f"""
## 输出格式

请用以下格式输出：

```yaml
---（design_spec.md 的 YAML frontmatter 在此）
---
```

随后是 markdown 正文内容。

如果有 SVG，请为每个页面输出完整的 SVG 代码，并用 ```svg 和 ``` 包裹。

请确保：
1. 所有字段值严格使用已确认的值，不要修改
2. SVG 必须格式正确、well-formed XML
3. 颜色使用六位 HEX（#RRGGBB）
4. 字体栈以 PPT-safe 字体结尾（如 Microsoft YaHei 或 Arial）
""")

    return "\n".join(prompt_parts)


# ── Template asset saving ──────────────────────────────────────────────────


def save_template_assets(
    kind: str,
    template_id: str,
    design_spec_md: str,
    svg_pages: list[dict[str, str]],
    target_dir: str | Path,
) -> None:
    """Write design_spec.md and per-page SVGs to the target template directory.

    Args:
        kind: "deck", "layout", or "brand"
        template_id: template identifier (snake_case)
        design_spec_md: complete design_spec.md content with YAML frontmatter
        svg_pages: list of {"filename": "01_cover.svg", "content": "<svg>...</svg>"}
        target_dir: where to write the files (e.g. templates/decks/<id>/)
    """
    out = Path(target_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Write design_spec.md
    (out / "design_spec.md").write_text(design_spec_md, encoding="utf-8")

    # Write SVG pages
    for page in svg_pages:
        filename = page.get("filename", "")
        content = page.get("content", "")
        if not filename or not content:
            continue
        (out / filename).write_text(content, encoding="utf-8")

    # For deck templates, create svg_final/ dir and copy SVGs there too
    if kind == "deck":
        svg_final = out / "svg_final"
        svg_final.mkdir(parents=True, exist_ok=True)
        for page in svg_pages:
            filename = page.get("filename", "")
            content = page.get("content", "")
            if not filename or not content:
                continue
            (svg_final / filename).write_text(content, encoding="utf-8")


def parse_svg_pages_from_llm_response(response_content: str) -> list[dict[str, str]]:
    """Extract SVG pages from an LLM response that may contain markdown code blocks.

    Returns a list of {"filename": "...", "content": "<svg>...</svg>"}.
    """
    import re

    pages: list[dict[str, str]] = []

    # Pattern 1: ```svg ... ``` with filename comment
    block_pattern = re.compile(
        r'```svg\s*\n(.*?)```',
        re.DOTALL,
    )
    filename_pattern = re.compile(
        r'(?:^|\n)(?://|<!--|#)\s*(0\d[a-z]?_[a-z_]+\.svg)',
        re.IGNORECASE,
    )

    blocks = block_pattern.findall(response_content)

    if not blocks:
        # Pattern 2: Look for bare <svg>...</svg> blocks
        svg_pattern = re.compile(
            r'(<svg\b.*?</svg>)',
            re.DOTALL | re.IGNORECASE,
        )
        svgs = svg_pattern.findall(response_content)
        for i, svg_content in enumerate(svgs):
            # Try to find filename near this SVG
            pos = response_content.find(svg_content)
            pre = response_content[max(0, pos - 200):pos]
            fname_match = re.search(r'(0\d[a-z]?_[a-z_]+\.svg)', pre)
            filename = fname_match.group(1) if fname_match else f"page_{i+1:02d}.svg"
            pages.append({"filename": filename, "content": svg_content.strip()})
        return pages

    # With ```svg blocks, try to identify filenames
    for block in blocks:
        # Look for filename in first line or nearby
        fname_match = re.search(r'(0\d[a-z]?_[a-z_]+\.svg)', block[:200])
        if fname_match:
            filename = fname_match.group(1)
        else:
            # Try to derive from page type
            ptype_match = re.search(r'cover|toc|chapter|content|ending', block[:200], re.IGNORECASE)
            if ptype_match:
                ptype = ptype_match.group(0).lower()
                index_map = {"cover": "01", "toc": "02", "chapter": "02a", "content": "03", "ending": "04"}
                prefix = index_map.get(ptype, "03")
                filename = f"{prefix}_{ptype}.svg"
            else:
                filename = f"page_{len(pages)+1:02d}.svg"

        # Extract the SVG from the block (strip extra text)
        svg_start = block.find("<svg")
        svg_end = block.rfind("</svg>") + len("</svg>")
        if svg_start >= 0 and svg_end > svg_start:
            svg_content = block[svg_start:svg_end].strip()
            pages.append({"filename": filename, "content": svg_content})

    return pages


def parse_design_spec_from_llm_response(response_content: str) -> str:
    """Extract design_spec.md content from LLM response (removes SVG blocks)."""
    import re

    # Remove SVG code blocks to leave only the design_spec content
    # Find ```yaml or --- delimited YAML frontmatter
    text = response_content.strip()

    # Remove all ```svg blocks
    text = re.sub(r'```svg\s*\n.*?```', '', text, flags=re.DOTALL)

    # Remove any remaining ``` blocks
    text = re.sub(r'```\w*\s*\n', '', text)
    text = text.replace('```', '')

    # Ensure it starts with YAML frontmatter
    if not text.startswith('---'):
        text = '---\n' + text

    return text.strip() + '\n'


def auto_detect_kind(manifest: dict[str, Any]) -> str:
    """Auto-detect whether a PPTX is a Deck, Layout, or Brand based on manifest content.

    Returns "deck", "layout", or "brand".
    """
    has_logo = False
    has_theme_colors = False
    has_custom_fonts = False

    # Check for branding signals
    theme = manifest.get("theme", {})
    theme_colors = theme.get("colors", {})
    if theme_colors and len(theme_colors) >= 3:
        has_theme_colors = True

    fonts = theme.get("fonts", {})
    standard_fonts = {"calibri", "arial", "times new roman", "helvetica", "宋体", "微软雅黑", ""}
    for _, v in fonts.items():
        if isinstance(v, str) and v.lower().strip() not in standard_fonts:
            has_custom_fonts = True
            break

    assets = manifest.get("assets", {})
    all_assets = assets.get("allAssets", [])
    common = assets.get("commonAssets", [])
    for a in (all_assets + common):
        name = str(a.get("name", "") if isinstance(a, dict) else a).lower()
        if "logo" in name:
            has_logo = True
            break

    slides = manifest.get("slides", [])
    layouts = manifest.get("layouts", [])
    has_structure = len(layouts) > 0 or len(slides) > 1

    branding_signals = sum([1 for s in [has_logo, has_theme_colors, has_custom_fonts] if s])

    # Decision logic — brand has identities but no layout structure
    if (has_logo or has_theme_colors) and not has_structure:
        return "brand"
    if has_structure and branding_signals == 0:
        return "layout"
    if has_structure and branding_signals >= 1:
        return "deck"

    # Default: deck is the most common
    return "deck"
