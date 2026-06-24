"""Template management API routes."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.auth.middleware import AuthContext, get_auth_context, require_admin, require_creator
from pptmaster.config import get_settings
from pptmaster.db.models import Template, TemplateUpload
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/templates", tags=["templates"])


class TemplateResponse(BaseModel):
    id: str
    template_id: str
    kind: str
    name: str
    summary: str
    canvas_format: str
    primary_color: str | None
    page_count: int | None
    page_types: list[str] | None
    is_builtin: bool
    preview_url: str | None

    model_config = {"from_attributes": True}


class ConfirmUploadRequest(BaseModel):
    template_id: str
    kind: str
    name: str
    summary: str
    canvas_format: str
    primary_color: str | None = None
    page_types: list[str] = []


@router.get("", response_model=list[TemplateResponse])
async def list_templates(
    kind: str | None = None,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        query = select(Template)
        if kind:
            query = query.where(Template.kind == kind)
        query = query.order_by(Template.created_at.desc()).limit(100)
        result = await session.execute(query)
        return [
            TemplateResponse(
                id=t.id,
                template_id=t.template_id,
                kind=t.kind,
                name=t.name,
                summary=t.summary,
                canvas_format=t.canvas_format,
                primary_color=t.primary_color,
                page_count=t.page_count,
                page_types=t.page_types,
                is_builtin=(t.uploaded_by is None),
                preview_url=(
                    f"/ppt-master/api/templates/{t.id}/preview/{t.preview_paths[0]}"
                    if t.preview_paths else None
                ),
            )
            for t in result.scalars().all()
        ]


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_template(
    file: UploadFile,
    auth: AuthContext = Depends(require_creator),
):
    if not file.filename or not file.filename.endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only PPTX files are accepted")

    upload_id = str(uuid4())
    staging_dir = f"/data/template_uploads/{upload_id}"
    staging_path = f"{staging_dir}/original.pptx"

    import os
    os.makedirs(staging_dir, exist_ok=True)

    content = await file.read()
    if len(content) > 200 * 1024 * 1024:  # 200MB limit
        raise HTTPException(status_code=400, detail="File too large (max 200MB)")

    with open(staging_path, "wb") as f:
        f.write(content)

    # ── G3.2: Run pptx_template_import synchronously ──────────────────────
    parse_result: dict | None = None
    parse_status = "parsing"
    parse_error: str | None = None

    try:
        from pptmaster.agent.tools.template import run_pptx_template_import
        import asyncio
        import_result = await run_pptx_template_import(staging_path, output_dir=staging_dir)

        if import_result.get("error"):
            parse_status = "import_failed"
            parse_error = import_result["error"]
        elif import_result.get("manifest_json_path"):
            # Parse manifest.json
            manifest_path = Path(import_result["manifest_json_path"])
            if manifest_path.is_file():
                import json
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                parse_result = {
                    "temp_dir": import_result["temp_dir"],
                    "manifest": manifest,
                    "svg_paths": import_result.get("svg_paths", []),
                    "asset_paths": import_result.get("asset_paths", []),
                }
                parse_status = "ready"
            else:
                parse_status = "import_failed"
                parse_error = "manifest.json not generated"
        else:
            parse_status = "ready"
            parse_result = {
                "temp_dir": import_result["temp_dir"],
                "manifest": {},
                "svg_paths": import_result.get("svg_paths", []),
                "asset_paths": import_result.get("asset_paths", []),
            }
    except Exception as exc:
        parse_status = "import_failed"
        parse_error = str(exc)

    async with open_db_session() as session:
        upload = TemplateUpload(
            id=upload_id,
            uploaded_by=auth.user_id,
            original_filename=file.filename,
            staging_path=staging_path,
            parse_status=parse_status,
            parse_result=parse_result,
            parse_error=parse_error,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
        )
        session.add(upload)
        await session.commit()

    response_body = {
        "upload_id": upload_id,
        "filename": file.filename,
        "status": parse_status,
        "message": "Template uploaded and analyzed" if parse_status == "ready" else "Template uploaded but analysis failed",
    }
    if parse_error:
        response_body["error"] = parse_error
    return response_body


@router.get("/uploads/{upload_id}")
async def get_upload_status(upload_id: str, auth: AuthContext = Depends(get_auth_context)):
    async with open_db_session() as session:
        result = await session.execute(
            select(TemplateUpload).where(
                TemplateUpload.id == upload_id, TemplateUpload.uploaded_by == auth.user_id
            )
        )
        upload = result.scalar_one_or_none()
        if not upload:
            raise HTTPException(status_code=404, detail="Upload not found")

        return {
            "upload_id": upload.id,
            "filename": upload.original_filename,
            "status": upload.parse_status,
            "parse_result": upload.parse_result,
            "parse_error": upload.parse_error,
        }


@router.get("/uploads/{upload_id}/extract-fields")
async def extract_fields_from_upload(
    upload_id: str,
    kind_hint: str = "auto",
    auth: AuthContext = Depends(get_auth_context),
):
    """Extract per-kind fields from an upload's parsed manifest for Step 2 confirmation."""
    async with open_db_session() as session:
        result = await session.execute(
            select(TemplateUpload).where(
                TemplateUpload.id == upload_id, TemplateUpload.uploaded_by == auth.user_id
            )
        )
        upload = result.scalar_one_or_none()
        if not upload:
            raise HTTPException(status_code=404, detail="Upload not found")

        if upload.parse_status not in ("ready",):
            raise HTTPException(status_code=400, detail=f"Upload not ready (status: {upload.parse_status})")

        manifest = (upload.parse_result or {}).get("manifest", {})
        if not manifest:
            return {"fields": {}, "auto_detected_kind": "deck"}

    from pptmaster.api._template_wizard import auto_detect_kind, extract_manifest_fields

    auto_kind = kind_hint if kind_hint in ("deck", "layout", "brand") else auto_detect_kind(manifest)
    fields = extract_manifest_fields(manifest, auto_kind)

    # Populate template_id and name from filename
    filename = upload.original_filename or ""
    base_name = filename.replace(".pptx", "").replace(".PPTX", "")
    snake_id = "".join(c if c.isalnum() else "_" for c in base_name).lower().strip("_")
    fields["template_id"] = {"value": snake_id, "provenance": "事实", "auto_detected": True}
    fields["name"] = {"value": base_name, "provenance": "事实", "auto_detected": True}

    return {"fields": fields, "auto_detected_kind": auto_kind}


@router.post("/uploads/{upload_id}/confirm")
async def confirm_upload(
    upload_id: str,
    request: ConfirmUploadRequest,
    auth: AuthContext = Depends(require_creator),
):
    # Validate template_id format
    import re
    if not re.match(r"^[a-z][a-z0-9_]*$", request.template_id):
        raise HTTPException(status_code=400, detail="Template ID must be snake_case ASCII")

    async with open_db_session() as session:
        result = await session.execute(
            select(TemplateUpload).where(
                TemplateUpload.id == upload_id, TemplateUpload.uploaded_by == auth.user_id
            )
        )
        upload = result.scalar_one_or_none()
        if not upload:
            raise HTTPException(status_code=404, detail="Upload not found")

        if upload.parse_status not in ("ready",):
            raise HTTPException(status_code=400, detail="Template not ready for confirmation")

        # Check template_id uniqueness
        result = await session.execute(
            select(Template).where(
                Template.template_id == request.template_id,
            )
        )
        if result.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="Template ID already exists")

        storage_path = f"/data/templates/{request.template_id}"

        template = Template(
            id=str(uuid4()),
            template_id=request.template_id,
            kind=request.kind,
            uploaded_by=auth.user_id,
            name=request.name,
            summary=request.summary,
            canvas_format=request.canvas_format,
            primary_color=request.primary_color,
            page_types=request.page_types,
            storage_path=storage_path,
        )
        session.add(template)

        upload.parse_status = "confirmed"
        await session.commit()

        return {
            "template_id": template.template_id,
            "name": template.name,
            "is_builtin": False,
            "status": "confirmed",
        }


@router.delete("/uploads/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_upload(upload_id: str, auth: AuthContext = Depends(require_creator)):
    async with open_db_session() as session:
        result = await session.execute(
            select(TemplateUpload).where(
                TemplateUpload.id == upload_id, TemplateUpload.uploaded_by == auth.user_id
            )
        )
        upload = result.scalar_one_or_none()
        if not upload:
            raise HTTPException(status_code=404, detail="Upload not found")

        upload.parse_status = "cancelled"
        await session.commit()

    return None


@router.get("/built-in")
async def list_built_in_templates(
    kind: str | None = None,
):
    """Return built-in layout and deck templates from PPT-Master skill's index files."""
    import base64
    import json
    from pathlib import Path

    templates_dir = Path(get_settings().skill_templates_root)
    result: list[dict] = []

    kinds_to_read = [kind] if kind else ["layout", "deck"]
    for k in kinds_to_read:
        if k == "layout":
            index_path = templates_dir / "layouts" / "layouts_index.json"
        elif k == "deck":
            index_path = templates_dir / "decks" / "decks_index.json"
        else:
            continue

        if not index_path.is_file():
            continue

        try:
            data = json.loads(index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        items = data.get("layouts", data) if k == "layout" else data.get("decks", data)
        if not isinstance(items, dict):
            continue

        for template_id, info in items.items():
            entry = {
                "id": template_id,
                "kind": k,
                "name": info.get("name", template_id),
                "summary": info.get("summary", ""),
                "canvas_format": info.get("canvas_format", "ppt169"),
                "page_count": info.get("page_count"),
                "page_types": info.get("page_types", []),
                "primary_color": info.get("primary_color"),
            }
            # Embed first-page SVG as a data URI for card preview.
            # Decks may store the cover at either decks/<id>/01_cover.svg
            # (built-in templates) or decks/<id>/svg_final/01_cover.svg
            # (post-processed templates) — try both.
            preview_candidates: list[Path] = []
            if k == "layout":
                preview_candidates.append(templates_dir / "layouts" / template_id / "01_cover.svg")
            else:
                deck_root = templates_dir / "decks" / template_id
                preview_candidates.append(deck_root / "01_cover.svg")
                preview_candidates.append(deck_root / "svg_final" / "01_cover.svg")
            for preview_svg in preview_candidates:
                if preview_svg.is_file():
                    try:
                        svg_bytes = preview_svg.read_bytes()
                        entry["preview_data_uri"] = (
                            "data:image/svg+xml;base64," + base64.b64encode(svg_bytes).decode("ascii")
                        )
                        break
                    except OSError:
                        continue

            result.append(entry)

    return result


@router.get("/{template_id}", response_model=TemplateResponse)
async def get_template(template_id: str, auth: AuthContext = Depends(get_auth_context)):
    async with open_db_session() as session:
        result = await session.execute(
            select(Template).where(Template.id == template_id)
        )
        template = result.scalar_one_or_none()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")

        return TemplateResponse(
            id=template.id,
            template_id=template.template_id,
            kind=template.kind,
            name=template.name,
            summary=template.summary,
            canvas_format=template.canvas_format,
            primary_color=template.primary_color,
            page_count=template.page_count,
            page_types=template.page_types,
            is_builtin=(template.uploaded_by is None),
            preview_url=(
                f"/ppt-master/api/templates/{template.id}/preview/{template.preview_paths[0]}"
                if template.preview_paths else None
            ),
        )


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(template_id: str, auth: AuthContext = Depends(require_creator)):
    async with open_db_session() as session:
        result = await session.execute(
            select(Template).where(
                Template.id == template_id,
                Template.uploaded_by == auth.user_id,  # can only delete user-uploaded templates
            )
        )
        template = result.scalar_one_or_none()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")

        await session.delete(template)
        await session.commit()

    return None


@router.get("/{template_id}/preview/{filename}")
async def get_template_preview(
    template_id: str,
    filename: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """Serve a preview file (SVG/PNG) from a template's storage_path.
    All templates are readable by any authed user. Filename is whitelisted
    against preview_paths to prevent path traversal."""
    from pathlib import Path
    from fastapi.responses import FileResponse

    async with open_db_session() as session:
        template = (await session.execute(
            select(Template).where(Template.id == template_id)
        )).scalar_one_or_none()
        if not template:
            raise HTTPException(404, "Template not found")

        if filename not in (template.preview_paths or []):
            raise HTTPException(404, "Preview not in whitelist")

        full = Path(template.storage_path) / filename
        if not full.is_file():
            raise HTTPException(404, "Preview file missing on disk")

        if filename.endswith(".svg"):
            media_type = "image/svg+xml"
        elif filename.endswith(".png"):
            media_type = "image/png"
        elif filename.endswith((".jpg", ".jpeg")):
            media_type = "image/jpeg"
        else:
            media_type = "application/octet-stream"

        return FileResponse(full, media_type=media_type)


# ── G3.4 + G3.5: Generate + Register endpoint ──────────────────────────────


class GenerateTemplateRequest(BaseModel):
    kind: str  # "deck", "layout", or "brand"
    template_id: str  # snake_case
    name: str
    summary: str
    canvas_format: str = "ppt169"
    primary_color: str | None = None
    colors: dict[str, Any] | None = None
    typography: dict[str, Any] | None = None
    logo: dict[str, Any] | None = None
    page_count: int | None = None
    page_types: list[str] = []
    image_strategy: str | None = None
    voice_tone: str | None = None


@router.post("/uploads/{upload_id}/generate")
async def generate_template(
    upload_id: str,
    request: GenerateTemplateRequest,
    auth: AuthContext = Depends(require_creator),
):
    """Generate a template using Template_Designer LLM and register it."""
    import re
    if not re.match(r"^[a-z][a-z0-9_]*$", request.template_id):
        raise HTTPException(status_code=400, detail="Template ID must be snake_case ASCII")

    if request.kind not in ("deck", "layout", "brand"):
        raise HTTPException(status_code=400, detail="Kind must be deck, layout, or brand")

    # Validate upload exists and is ready
    async with open_db_session() as session:
        result = await session.execute(
            select(TemplateUpload).where(
                TemplateUpload.id == upload_id, TemplateUpload.uploaded_by == auth.user_id
            )
        )
        upload = result.scalar_one_or_none()
        if not upload:
            raise HTTPException(status_code=404, detail="Upload not found")

        if upload.parse_status not in ("ready",):
            raise HTTPException(status_code=400, detail=f"Template not ready (status: {upload.parse_status})")

        # Check template_id uniqueness
        result = await session.execute(
            select(Template).where(Template.template_id == request.template_id)
        )
        if result.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="Template ID already exists")

        manifest = (upload.parse_result or {}).get("manifest", {})

    # Build prompt and call LLM
    confirmed_fields = request.model_dump(exclude_none=False)

    try:
        from pptmaster.api._template_wizard import (
            build_template_designer_prompt,
            parse_svg_pages_from_llm_response,
            parse_design_spec_from_llm_response,
            save_template_assets,
        )
        from pptmaster.llm.provider import get_chat_model

        prompt = build_template_designer_prompt(
            kind=request.kind,
            confirmed_fields=confirmed_fields,
            manifest=manifest,
            svg_paths=(upload.parse_result or {}).get("svg_paths", []),
        )

        model = await get_chat_model(role="template_designer")
        raw_response = await model.ainvoke(prompt)
        response_text = raw_response.content if hasattr(raw_response, "content") else str(raw_response)
        # LangChain AIMessage.content can be str | list; ensure str
        if not isinstance(response_text, str):
            response_text = str(response_text)

    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Template_Designer LLM failed: {exc}")

    # Parse LLM response into design_spec and SVGs
    design_spec_md = parse_design_spec_from_llm_response(response_text)
    svg_pages = parse_svg_pages_from_llm_response(response_text)

    if kind_has_svgs := request.kind != "brand":
        if not svg_pages:
            raise HTTPException(status_code=502, detail="Template_Designer produced no SVG pages")

    # Save to target directory
    templates_root = Path(get_settings().pptmaster_templates_dir)
    if not templates_root.is_dir():
        templates_root = Path(get_settings().skill_templates_root)
        if not templates_root.is_dir():
            import tempfile
            templates_root = Path(tempfile.mkdtemp(prefix="pptmaster_templates_"))

    kind_dir_name = {"deck": "decks", "layout": "layouts", "brand": "brands"}[request.kind]
    target_dir = templates_root / kind_dir_name / request.template_id

    save_template_assets(
        kind=request.kind,
        template_id=request.template_id,
        design_spec_md=design_spec_md,
        svg_pages=svg_pages,
        target_dir=target_dir,
    )

    # ── G3.5: QC + Register ───────────────────────────────────────────────
    qc_warnings = 0
    qc_errors = 0
    qc_output = ""

    if kind_has_svgs:
        try:
            from pptmaster.agent.tools.template import run_svg_quality_checker
            qc_result = await run_svg_quality_checker(str(target_dir))
            qc_warnings = qc_result.get("warnings", 0)
            qc_errors = qc_result.get("errors", 0)
            qc_output = qc_result.get("stdout", "")
        except Exception:
            qc_output = "QC runner failed (non-fatal)"

    # Register in the kind-specific index
    register_ok = False
    register_output = ""
    try:
        from pptmaster.agent.tools.template import run_register_template
        reg_result = await run_register_template(request.template_id, kind=request.kind)
        register_ok = reg_result.get("success", False)
        register_output = reg_result.get("stdout", "")
    except Exception as exc:
        register_output = str(exc)

    # Compute page_count from actual SVGs or manifest
    actual_page_count = request.page_count or len(svg_pages) or len(manifest.get("slides", []))

    # Create Template DB row
    storage_path = str(target_dir)
    preview_paths = [p["filename"] for p in svg_pages] if svg_pages else []

    async with open_db_session() as session:
        result = await session.execute(
            select(TemplateUpload).where(TemplateUpload.id == upload_id)
        )
        upload = result.scalar_one_or_none()

        template = Template(
            id=str(uuid4()),
            template_id=request.template_id,
            kind=request.kind,
            uploaded_by=auth.user_id,
            name=request.name,
            summary=request.summary,
            canvas_format=request.canvas_format,
            primary_color=request.primary_color,
            page_count=actual_page_count,
            page_types=request.page_types or [],
            preview_paths=preview_paths,
            storage_path=storage_path,
        )
        session.add(template)

        if upload:
            upload.parse_status = "active"
        await session.commit()

    return {
        "status": "generated",
        "template_id": request.template_id,
        "kind": request.kind,
        "name": request.name,
        "page_count": actual_page_count,
        "svg_pages": len(svg_pages),
        "design_spec_preview": design_spec_md[:500] + ("..." if len(design_spec_md) > 500 else ""),
        "qc_warnings": qc_warnings,
        "qc_errors": qc_errors,
        "register_ok": register_ok,
    }
