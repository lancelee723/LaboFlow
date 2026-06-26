"""Settings API routes (LLM config, image backends, profile)."""

import asyncio
import time

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from pptmaster.api._errors import AppError, ErrorCode
from pptmaster.auth.middleware import AuthContext, get_auth_context, require_admin
from pptmaster.auth.password import hash_password, verify_password
from pptmaster.db.models import LLMConfig, User
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/settings", tags=["settings"])


class LLMConfigRequest(BaseModel):
    provider: str
    model: str
    endpoint: str | None = None
    api_key: str | None = None
    role_preference: str | None = None
    is_default: bool = False
    display_name: str | None = None


class LLMConfigResponse(BaseModel):
    id: str
    provider: str
    model: str
    endpoint: str | None
    role_preference: str | None
    is_default: bool
    display_name: str | None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ProfileResponse(BaseModel):
    id: str
    email: str
    name: str | None
    locale: str
    role: str
    is_server_admin: bool


@router.get("/llm", response_model=list[LLMConfigResponse])
async def list_llm_configs(auth: AuthContext = Depends(require_admin)):
    async with open_db_session() as session:
        result = await session.execute(
            select(LLMConfig)
        )
        configs = result.scalars().all()
        return [
            LLMConfigResponse(
                id=c.id,
                provider=c.provider,
                model=c.model,
                endpoint=c.endpoint,
                role_preference=c.role_preference,
                is_default=c.is_default,
                display_name=c.display_name,
            )
            for c in configs
        ]


class AvailableLLMConfig(BaseModel):
    id: str
    provider: str
    model: str
    display_name: str | None
    is_default: bool


@router.get("/llm/available", response_model=list[AvailableLLMConfig])
async def list_available_llm_configs(auth: AuthContext = Depends(get_auth_context)):
    """Non-admin readable list — populates the project-setup model picker.
    Excludes endpoint and API key material; safe to expose to all users."""
    async with open_db_session() as session:
        result = await session.execute(select(LLMConfig))
        configs = result.scalars().all()
        return [
            AvailableLLMConfig(
                id=c.id,
                provider=c.provider,
                model=c.model,
                display_name=c.display_name,
                is_default=c.is_default,
            )
            for c in configs
        ]


@router.put("/llm", response_model=LLMConfigResponse, status_code=status.HTTP_201_CREATED)
async def create_llm_config(
    request: LLMConfigRequest,
    auth: AuthContext = Depends(require_admin),
):
    from uuid import uuid4

    async with open_db_session() as session:
        if request.is_default:
            existing = (await session.execute(
                select(LLMConfig).where(LLMConfig.is_default == True)
            )).scalars().all()
            for e in existing:
                e.is_default = False

        config = LLMConfig(
            id=str(uuid4()),
            created_by=auth.user_id,
            provider=request.provider,
            model=request.model,
            endpoint=request.endpoint,
            api_key_encrypted=request.api_key.encode("utf-8") if request.api_key else None,
            role_preference=request.role_preference,
            is_default=request.is_default,
            display_name=request.display_name,
        )
        session.add(config)
        await session.commit()

        return LLMConfigResponse(
            id=config.id,
            provider=config.provider,
            model=config.model,
            endpoint=config.endpoint,
            role_preference=config.role_preference,
            is_default=config.is_default,
            display_name=config.display_name,
        )


@router.delete("/llm/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_llm_config(config_id: str, auth: AuthContext = Depends(require_admin)):
    async with open_db_session() as session:
        result = await session.execute(
            select(LLMConfig).where(
                LLMConfig.id == config_id
            )
        )
        config = result.scalar_one_or_none()
        if not config:
            raise AppError(ErrorCode.LLM_CONFIG_NOT_FOUND, "Config not found", status_code=404)

        await session.delete(config)
        await session.commit()

    return None


class UpdateLLMConfigRequest(BaseModel):
    provider: str | None = None
    model: str | None = None
    api_key: str | None = None
    endpoint: str | None = None
    role_preference: str | None = None
    is_default: bool | None = None
    display_name: str | None = None


@router.patch("/llm/{config_id}", response_model=LLMConfigResponse)
async def update_llm_config(
    config_id: str,
    request: UpdateLLMConfigRequest,
    auth: AuthContext = Depends(require_admin),
):
    async with open_db_session() as session:
        config = (await session.execute(
            select(LLMConfig).where(
                LLMConfig.id == config_id
            )
        )).scalar_one_or_none()
        if not config:
            raise AppError(ErrorCode.LLM_CONFIG_NOT_FOUND, "Config not found", status_code=404)

        if request.provider is not None:
            config.provider = request.provider
        if request.model is not None:
            config.model = request.model
        if request.api_key is not None:
            config.api_key_encrypted = request.api_key.encode("utf-8")
        if request.endpoint is not None:
            config.endpoint = request.endpoint
        if request.role_preference is not None:
            config.role_preference = request.role_preference
        if request.is_default is True and not config.is_default:
            others = (await session.execute(
                select(LLMConfig).where(LLMConfig.is_default == True, LLMConfig.id != config_id)
            )).scalars().all()
            for e in others:
                e.is_default = False
            config.is_default = True
        elif request.is_default is False:
            config.is_default = False
        if request.display_name is not None:
            config.display_name = request.display_name

        await session.commit()

        return LLMConfigResponse(
            id=config.id,
            provider=config.provider,
            model=config.model,
            endpoint=config.endpoint,
            role_preference=config.role_preference,
            is_default=config.is_default,
            display_name=config.display_name,
        )


@router.get("/profile", response_model=ProfileResponse)
async def get_profile(auth: AuthContext = Depends(get_auth_context)):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.id == auth.user_id))
        user = result.scalar_one_or_none()

        return ProfileResponse(
            id=user.id if user else auth.user_id,
            email=user.email if user else (auth.email or ""),
            name=user.name if user else None,
            locale=user.locale if user else "en",
            role=auth.role,
            is_server_admin=auth.is_server_admin,
        )


@router.post("/profile/change-password")
async def change_password_profile(
    request: ChangePasswordRequest,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.id == auth.user_id))
        user = result.scalar_one_or_none()

        if not user or not user.password_hash:
            raise AppError(ErrorCode.AUTH_SSO_PASSWORD_NOT_AVAILABLE, "Password change not available")

        if not verify_password(request.current_password, user.password_hash):
            raise AppError(ErrorCode.AUTH_WRONG_PASSWORD, "Current password is incorrect")

        user.password_hash = hash_password(request.new_password)
        user.must_change_password = False
        await session.commit()

        return {"success": True}



@router.post("/llm/{config_id}/test")
async def test_llm_config(
    config_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """Probe the LLM provider with a minimal request to verify connectivity.
    Returns 200 with success=true/false in the body — does not raise on auth
    or quota errors. Times out after 30 seconds."""
    from pptmaster.llm.provider import build_chat_model_from_config

    async with open_db_session() as session:
        config = (await session.execute(
            select(LLMConfig).where(
                LLMConfig.id == config_id,
            )
        )).scalar_one_or_none()
        if not config:
            raise AppError(ErrorCode.LLM_CONFIG_NOT_FOUND, "Config not found", status_code=404)

    try:
        model = build_chat_model_from_config(config)
    except Exception as e:
        return {"success": False, "response": None, "error": f"build_error: {e}", "latency_ms": 0}

    start = time.perf_counter()
    try:
        result = await asyncio.wait_for(
            model.ainvoke("Say only the word OK"),
            timeout=30.0,
        )
        latency_ms = int((time.perf_counter() - start) * 1000)
        content = result.content if hasattr(result, "content") else str(result)
        return {"success": True, "response": str(content)[:200], "error": None, "latency_ms": latency_ms}
    except asyncio.TimeoutError:
        return {"success": False, "response": None, "error": "Timeout after 30s", "latency_ms": 30000}
    except Exception as e:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {"success": False, "response": None, "error": str(e)[:500], "latency_ms": latency_ms}


class LLMTestRequest(BaseModel):
    provider: str
    model: str
    api_key: str | None = None
    endpoint: str | None = None


@router.post("/llm/test")
async def test_llm_inline(
    request: LLMTestRequest,
    auth: AuthContext = Depends(get_auth_context),
):
    """Probe an unsaved LLM configuration (Add Provider form).
    Builds a transient LLMConfig, then reuses build_chat_model_from_config."""
    from uuid import uuid4
    from pptmaster.llm.provider import build_chat_model_from_config

    transient = LLMConfig(
        id=str(uuid4()),
        created_by=auth.user_id,
        provider=request.provider,
        model=request.model,
        endpoint=request.endpoint,
        api_key_encrypted=request.api_key.encode("utf-8") if request.api_key else None,
    )

    try:
        model = build_chat_model_from_config(transient)
    except Exception as e:
        return {"success": False, "response": None, "error": f"build_error: {e}", "latency_ms": 0}

    start = time.perf_counter()
    try:
        result = await asyncio.wait_for(
            model.ainvoke("Say only the word OK"),
            timeout=30.0,
        )
        latency_ms = int((time.perf_counter() - start) * 1000)
        content = result.content if hasattr(result, "content") else str(result)
        return {"success": True, "response": str(content)[:200], "error": None, "latency_ms": latency_ms}
    except asyncio.TimeoutError:
        return {"success": False, "response": None, "error": "Timeout after 30s", "latency_ms": 30000}
    except Exception as e:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {"success": False, "response": None, "error": str(e)[:500], "latency_ms": latency_ms}


# ─── Image Backend (AI generation) — backend catalog ─────────────────────


class ImageBackendInfo(BaseModel):
    name: str
    label: str
    tier: str
    default_model: str
    key_hint: str


@router.get("/image-backends/available", response_model=list[ImageBackendInfo])
async def list_available_image_backends() -> list[ImageBackendInfo]:
    """Return the image_gen.py backend registry (catalog for Add form)."""
    import json
    import subprocess

    from pptmaster.config import get_settings as _gs

    scripts_dir = _gs().pptmaster_scripts_dir
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["python3", f"{scripts_dir}/image_gen.py", "--list-backends", "--json"],
            capture_output=True, text=True, timeout=10,
        )
    except subprocess.TimeoutExpired:
        raise AppError(ErrorCode.UPSTREAM_TIMEOUT, "image_gen.py timed out", status_code=504)

    if result.returncode != 0:
        raise AppError(ErrorCode.UPSTREAM_ERROR, f"image_gen.py failed: {result.stderr[:200]}", status_code=502)

    return [ImageBackendInfo(**item) for item in json.loads(result.stdout)]


# ─── Image Backend (AI generation) — admin CRUD ───────────────────────────


class ImageBackendRequest(BaseModel):
    backend: str
    model: str | None = None
    api_key: str
    base_url: str | None = None
    is_default: bool = False
    display_name: str | None = None


class ImageBackendUpdateRequest(BaseModel):
    backend: str | None = None
    model: str | None = None
    api_key: str | None = None  # None == keep existing
    base_url: str | None = None
    is_default: bool | None = None
    display_name: str | None = None


class ImageBackendResponse(BaseModel):
    id: str
    backend: str
    model: str | None
    base_url: str | None
    is_default: bool
    display_name: str | None
    has_api_key: bool


def _to_image_backend_response(c) -> ImageBackendResponse:
    return ImageBackendResponse(
        id=c.id,
        backend=c.backend,
        model=c.model,
        base_url=c.base_url,
        is_default=c.is_default,
        display_name=c.display_name,
        has_api_key=bool(c.api_key_encrypted),
    )


@router.get("/image-backends", response_model=list[ImageBackendResponse])
async def list_image_backends(auth: AuthContext = Depends(require_admin)):
    from pptmaster.db.models import ImageBackendConfig
    async with open_db_session() as session:
        rows = (await session.execute(select(ImageBackendConfig))).scalars().all()
        return [_to_image_backend_response(r) for r in rows]


@router.put("/image-backends", response_model=ImageBackendResponse, status_code=status.HTTP_201_CREATED)
async def create_image_backend(req: ImageBackendRequest, auth: AuthContext = Depends(require_admin)):
    from uuid import uuid4
    from pptmaster.db.models import ImageBackendConfig

    async with open_db_session() as session:
        if req.is_default:
            existing = (await session.execute(
                select(ImageBackendConfig).where(ImageBackendConfig.is_default == True)
            )).scalars().all()
            for e in existing:
                e.is_default = False

        cfg = ImageBackendConfig(
            id=str(uuid4()),
            created_by=auth.user_id,
            backend=req.backend,
            model=req.model,
            api_key_encrypted=req.api_key.encode("utf-8"),
            base_url=req.base_url,
            is_default=req.is_default,
            display_name=req.display_name,
        )
        session.add(cfg)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise AppError(
                ErrorCode.CONFLICT,
                "Another backend already has is_default=True; only one is allowed",
                status_code=409,
            )
        await session.refresh(cfg)
        return _to_image_backend_response(cfg)


@router.patch("/image-backends/{config_id}", response_model=ImageBackendResponse)
async def update_image_backend(
    config_id: str,
    req: ImageBackendUpdateRequest,
    auth: AuthContext = Depends(require_admin),
):
    from pptmaster.db.models import ImageBackendConfig

    async with open_db_session() as session:
        cfg = (await session.execute(
            select(ImageBackendConfig).where(ImageBackendConfig.id == config_id)
        )).scalar_one_or_none()
        if not cfg:
            raise AppError(ErrorCode.LLM_CONFIG_NOT_FOUND, "Config not found", status_code=404)

        if req.is_default is True and not cfg.is_default:
            existing = (await session.execute(
                select(ImageBackendConfig)
                .where(ImageBackendConfig.is_default == True)
                .where(ImageBackendConfig.id != config_id)
            )).scalars().all()
            for e in existing:
                e.is_default = False

        if req.backend is not None:
            cfg.backend = req.backend
        if req.model is not None:
            cfg.model = req.model
        if req.api_key is not None:
            cfg.api_key_encrypted = req.api_key.encode("utf-8")
        if req.base_url is not None:
            cfg.base_url = req.base_url
        if req.is_default is not None:
            cfg.is_default = req.is_default
        if req.display_name is not None:
            cfg.display_name = req.display_name

        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise AppError(
                ErrorCode.CONFLICT,
                "Another backend already has is_default=True; only one is allowed",
                status_code=409,
            )
        await session.refresh(cfg)
        return _to_image_backend_response(cfg)


@router.delete("/image-backends/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_image_backend(config_id: str, auth: AuthContext = Depends(require_admin)):
    from pptmaster.db.models import ImageBackendConfig

    async with open_db_session() as session:
        cfg = (await session.execute(
            select(ImageBackendConfig).where(ImageBackendConfig.id == config_id)
        )).scalar_one_or_none()
        if not cfg:
            raise AppError(ErrorCode.LLM_CONFIG_NOT_FOUND, "Config not found", status_code=404)
        await session.delete(cfg)
        await session.commit()
    return None


# ─── Image Search (Web search) — admin-only CRUD ─────────────────────

SUPPORTED_IMAGE_SEARCH_PROVIDERS = {"pexels", "pixabay"}


class ImageSearchRequest(BaseModel):
    provider: str
    api_key: str


class ImageSearchResponse(BaseModel):
    id: str
    provider: str
    has_api_key: bool


def _to_image_search_response(c) -> ImageSearchResponse:
    return ImageSearchResponse(
        id=c.id,
        provider=c.provider,
        has_api_key=bool(c.api_key_encrypted),
    )


@router.get("/image-search", response_model=list[ImageSearchResponse])
async def list_image_search(auth: AuthContext = Depends(require_admin)):
    from pptmaster.db.models import ImageSearchConfig
    async with open_db_session() as session:
        rows = (await session.execute(select(ImageSearchConfig))).scalars().all()
        return [_to_image_search_response(r) for r in rows]


@router.put("/image-search", response_model=ImageSearchResponse)
async def upsert_image_search(req: ImageSearchRequest, auth: AuthContext = Depends(require_admin)):
    from uuid import uuid4
    from pptmaster.db.models import ImageSearchConfig

    if req.provider not in SUPPORTED_IMAGE_SEARCH_PROVIDERS:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            f"Unsupported provider '{req.provider}'. Supported: {sorted(SUPPORTED_IMAGE_SEARCH_PROVIDERS)}",
            status_code=422,
        )

    async with open_db_session() as session:
        existing = (await session.execute(
            select(ImageSearchConfig).where(ImageSearchConfig.provider == req.provider)
        )).scalar_one_or_none()
        if existing:
            existing.api_key_encrypted = req.api_key.encode("utf-8")
            await session.commit()
            await session.refresh(existing)
            return _to_image_search_response(existing)

        cfg = ImageSearchConfig(
            id=str(uuid4()),
            created_by=auth.user_id,
            provider=req.provider,
            api_key_encrypted=req.api_key.encode("utf-8"),
        )
        session.add(cfg)
        await session.commit()
        await session.refresh(cfg)
        return _to_image_search_response(cfg)


@router.delete("/image-search/{provider}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_image_search(provider: str, auth: AuthContext = Depends(require_admin)):
    from pptmaster.db.models import ImageSearchConfig

    async with open_db_session() as session:
        cfg = (await session.execute(
            select(ImageSearchConfig).where(ImageSearchConfig.provider == provider)
        )).scalar_one_or_none()
        if cfg:
            await session.delete(cfg)
            await session.commit()
    return None


import tempfile
import time as _time


@router.post("/image-backends/{config_id}/test")
async def test_image_backend_probe(config_id: str, auth: AuthContext = Depends(require_admin)):
    """Generate a 1x1 256px test image to verify backend + key. Times out at 60s."""
    from pptmaster.agent.tools.source import run_script
    from pptmaster.db.models import ImageBackendConfig

    async with open_db_session() as session:
        cfg = (await session.execute(
            select(ImageBackendConfig).where(ImageBackendConfig.id == config_id)
        )).scalar_one_or_none()
        if not cfg:
            raise AppError(ErrorCode.LLM_CONFIG_NOT_FOUND, "Config not found", status_code=404)

    extra_env = {
        "IMAGE_BACKEND": cfg.backend,
        f"{cfg.backend.upper()}_API_KEY": cfg.api_key_encrypted.decode("utf-8"),
    }
    if cfg.model:
        extra_env[f"{cfg.backend.upper()}_MODEL"] = cfg.model
    if cfg.base_url:
        extra_env[f"{cfg.backend.upper()}_BASE_URL"] = cfg.base_url

    with tempfile.TemporaryDirectory() as tmp:
        start = _time.perf_counter()
        result = await run_script(
            "image_gen.py",
            "A simple solid blue square, no text",
            "--aspect_ratio", "1:1",
            "--image_size", "512px",
            "-o", tmp,
            cwd=tmp, timeout_sec=60, extra_env=extra_env,
        )
        latency_ms = int((_time.perf_counter() - start) * 1000)
        return {
            "success": bool(result.get("success")),
            "error": result.get("error"),
            "latency_ms": latency_ms,
        }
