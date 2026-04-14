"""FastAPI routes for runtime LLM provider configuration.

This is the only module that imports both `runtime_config` and
`llm_config_apply`. It also owns the apply lock and the pydantic request /
response models. Everything else is kept out of here so the two helper
modules can be tested offline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from lightrag.api.auth import auth_handler
from lightrag.api.llm_config_apply import (
    DiffKind,
    FactoryBundle,
    apply_hot,
    classify_diff,
    clear_indexed_data,
)
from lightrag.api.runtime_config import (
    RuntimeConfig,
    SectionConfig,
    load_runtime_overlay,
    mask_key,
    save_runtime_overlay,
    unmask_or_keep,
)


router = APIRouter(tags=["llm-config"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login", auto_error=False)


# ─── Auth dependency ────────────────────────────────────────────────────────


async def require_platform_admin(token: Optional[str] = Depends(oauth2_scheme)) -> dict:
    """Decode the bearer token and require `role == "platform_admin"`."""
    if not token:
        raise HTTPException(status_code=401, detail="not_authenticated")
    try:
        info = auth_handler.validate_token(token)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="invalid_token")
    role = info.get("role")
    if role != "platform_admin":
        raise HTTPException(status_code=403, detail="admin_required")
    return info


# ─── Provider catalog (static) ──────────────────────────────────────────────


PROVIDERS = {
    "llm_bindings": ["openai", "ollama", "azure_openai", "gemini", "aws_bedrock", "lollms"],
    "openai_compatible_presets": [
        {"id": "openai",     "display_name": "OpenAI",            "base_url": "https://api.openai.com/v1",                                "default_max_tokens": 16384},
        {"id": "deepseek",   "display_name": "DeepSeek",          "base_url": "https://api.deepseek.com/v1",                              "default_max_tokens": 8192},
        {"id": "kimi",       "display_name": "Kimi",              "base_url": "https://api.moonshot.cn/v1",                               "default_max_tokens": 8192},
        {"id": "qwen",       "display_name": "Qwen (DashScope)",  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",        "default_max_tokens": 8192},
        {"id": "zhipu",      "display_name": "Zhipu",             "base_url": "https://open.bigmodel.cn/api/paas/v4",                     "default_max_tokens": 8192},
        {"id": "openrouter", "display_name": "OpenRouter",        "base_url": "https://openrouter.ai/api/v1",                             "default_max_tokens": 4096},
        {"id": "vllm",       "display_name": "vLLM",              "base_url": "http://localhost:8000/v1",                                 "default_max_tokens": 4096},
        {"id": "sglang",     "display_name": "SGLang",            "base_url": "http://localhost:30000/v1",                                "default_max_tokens": 4096},
        {"id": "custom",     "display_name": "Custom",            "base_url": "",                                                          "default_max_tokens": 4096},
    ],
    "embedding_bindings": ["openai", "ollama", "gemini", "jina", "azure_openai", "aws_bedrock", "lollms"],
    "rerank_bindings": ["cohere", "jina", "aliyun"],
}


# ─── Response models ────────────────────────────────────────────────────────


class LLMSectionOut(BaseModel):
    binding: Optional[str]
    host: Optional[str]
    model: Optional[str]
    api_key_masked: str
    max_async: Optional[int] = None
    timeout: Optional[int] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    source: str  # "overlay" | "env"


class EmbeddingSectionOut(BaseModel):
    binding: Optional[str]
    host: Optional[str]
    model: Optional[str]
    api_key_masked: str
    dim: Optional[int] = None
    token_limit: Optional[int] = None
    send_dim: Optional[bool] = None
    timeout: Optional[int] = None
    source: str


class RerankSectionOut(BaseModel):
    enabled: bool
    binding: Optional[str]
    host: Optional[str]
    model: Optional[str]
    api_key_masked: str
    source: str


class LLMConfigOut(BaseModel):
    generation: int
    llm: LLMSectionOut
    embedding: EmbeddingSectionOut
    rerank: RerankSectionOut
    providers: dict
    has_indexed_data: bool


# ─── Request models ─────────────────────────────────────────────────────────


class LLMSectionIn(BaseModel):
    binding: Optional[str]
    host: Optional[str]
    model: Optional[str]
    api_key: Optional[str] = ""
    max_async: Optional[int] = None
    timeout: Optional[int] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


class EmbeddingSectionIn(BaseModel):
    binding: Optional[str]
    host: Optional[str]
    model: Optional[str]
    api_key: Optional[str] = ""
    dim: Optional[int] = None
    token_limit: Optional[int] = None
    send_dim: Optional[bool] = None
    timeout: Optional[int] = None


class RerankSectionIn(BaseModel):
    enabled: bool = False
    binding: Optional[str] = None
    host: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = ""


class LLMConfigIn(BaseModel):
    generation: int
    force_clear: bool = False
    llm: LLMSectionIn
    embedding: EmbeddingSectionIn
    rerank: RerankSectionIn


# ─── Helpers to build RuntimeConfig from app.state.args ─────────────────────


def _current_config(args: argparse.Namespace, generation: int) -> RuntimeConfig:
    return RuntimeConfig(
        generation=generation,
        llm=SectionConfig(
            binding=args.llm_binding,
            host=args.llm_binding_host,
            model=args.llm_model,
            api_key=args.llm_binding_api_key,
            max_async=args.max_async,
            timeout=getattr(args, "timeout", None),
            temperature=getattr(args, "openai_llm_temperature", None),
            max_tokens=getattr(args, "openai_llm_max_tokens", None),
        ),
        embedding=SectionConfig(
            binding=args.embedding_binding,
            host=args.embedding_binding_host,
            model=args.embedding_model,
            api_key=args.embedding_binding_api_key,
            dim=args.embedding_dim,
            token_limit=getattr(args, "embedding_token_limit", None),
            send_dim=getattr(args, "embedding_send_dim", None),
            timeout=getattr(args, "embedding_timeout", None),
        ),
        rerank=SectionConfig(
            enabled=(args.rerank_binding != "null"),
            binding=args.rerank_binding if args.rerank_binding != "null" else None,
            host=args.rerank_binding_host,
            model=args.rerank_model,
            api_key=args.rerank_binding_api_key,
        ),
    )


def _read_overlay_generation(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        return int(json.loads(path.read_text()).get("generation", 0))
    except Exception:
        return 0


async def _has_indexed_data(rag: Any) -> bool:
    try:
        counts = await rag.doc_status.get_status_counts()
    except Exception:
        return False
    return sum(counts.values()) > 0


# ─── GET /llm-config ────────────────────────────────────────────────────────


@router.get("/llm-config", response_model=LLMConfigOut)
async def get_llm_config(
    request: Request,
    _: dict = Depends(require_platform_admin),
) -> LLMConfigOut:
    args: argparse.Namespace = request.app.state.args
    rag = request.app.state.rag
    overlay_path: Path = request.app.state.overlay_path
    generation = _read_overlay_generation(overlay_path)

    # Which sections came from the overlay vs .env?
    overlay_sections: set[str] = set()
    if overlay_path.exists():
        try:
            data = json.loads(overlay_path.read_text())
            for key in ("llm", "embedding", "rerank"):
                if data.get(key):
                    overlay_sections.add(key)
        except Exception:
            pass

    def _src(section: str) -> str:
        return "overlay" if section in overlay_sections else "env"

    has_data = await _has_indexed_data(rag)

    return LLMConfigOut(
        generation=generation,
        llm=LLMSectionOut(
            binding=args.llm_binding,
            host=args.llm_binding_host,
            model=args.llm_model,
            api_key_masked=mask_key(args.llm_binding_api_key or ""),
            max_async=args.max_async,
            timeout=getattr(args, "timeout", None),
            temperature=getattr(args, "openai_llm_temperature", None),
            max_tokens=getattr(args, "openai_llm_max_tokens", None),
            source=_src("llm"),
        ),
        embedding=EmbeddingSectionOut(
            binding=args.embedding_binding,
            host=args.embedding_binding_host,
            model=args.embedding_model,
            api_key_masked=mask_key(args.embedding_binding_api_key or ""),
            dim=args.embedding_dim,
            token_limit=getattr(args, "embedding_token_limit", None),
            send_dim=getattr(args, "embedding_send_dim", None),
            timeout=getattr(args, "embedding_timeout", None),
            source=_src("embedding"),
        ),
        rerank=RerankSectionOut(
            enabled=(args.rerank_binding != "null"),
            binding=args.rerank_binding if args.rerank_binding != "null" else None,
            host=args.rerank_binding_host,
            model=args.rerank_model,
            api_key_masked=mask_key(args.rerank_binding_api_key or ""),
            source=_src("rerank"),
        ),
        providers=PROVIDERS,
        has_indexed_data=has_data,
    )


# ─── POST /llm-config ───────────────────────────────────────────────────────


def _build_new_config(old: RuntimeConfig, body: LLMConfigIn) -> RuntimeConfig:
    """Merge `body` into a new RuntimeConfig using `old` for masked-key
    sentinel resolution."""
    return RuntimeConfig(
        generation=body.generation,
        llm=SectionConfig(
            binding=body.llm.binding,
            host=body.llm.host,
            model=body.llm.model,
            api_key=unmask_or_keep(body.llm.api_key or "", old.llm.api_key or ""),
            max_async=body.llm.max_async,
            timeout=body.llm.timeout,
            temperature=body.llm.temperature,
            max_tokens=body.llm.max_tokens,
        ),
        embedding=SectionConfig(
            binding=body.embedding.binding,
            host=body.embedding.host,
            model=body.embedding.model,
            api_key=unmask_or_keep(body.embedding.api_key or "", old.embedding.api_key or ""),
            dim=body.embedding.dim,
            token_limit=body.embedding.token_limit,
            send_dim=body.embedding.send_dim,
            timeout=body.embedding.timeout,
        ),
        rerank=SectionConfig(
            enabled=body.rerank.enabled,
            binding=(body.rerank.binding if body.rerank.enabled and body.rerank.binding else None),
            host=body.rerank.host,
            model=body.rerank.model,
            api_key=unmask_or_keep(body.rerank.api_key or "", old.rerank.api_key or ""),
        ),
    )


@router.post("/llm-config")
async def post_llm_config(
    body: LLMConfigIn,
    request: Request,
    _: dict = Depends(require_platform_admin),
):
    args: argparse.Namespace = request.app.state.args
    rag = request.app.state.rag
    overlay_path: Path = request.app.state.overlay_path
    lock: asyncio.Lock = request.app.state.llm_config_lock
    factories: FactoryBundle = request.app.state.factories

    async with lock:
        current_gen = _read_overlay_generation(overlay_path)
        if body.generation != current_gen:
            raise HTTPException(
                status_code=409,
                detail={"error": "stale_config", "current_generation": current_gen},
            )

        old = _current_config(args, current_gen)
        new = _build_new_config(old, body)
        diff = classify_diff(old, new)

        if diff == DiffKind.NONE:
            return {"status": "applied", "generation": current_gen}

        is_destructive = diff in (DiffKind.EMBEDDING_REBUILD, DiffKind.MULTIPLE_WITH_REBUILD)

        if is_destructive:
            has_data = await _has_indexed_data(rag)
            if has_data and not body.force_clear:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "embedding_rebuild_requires_clear",
                        "has_indexed_data": True,
                        "will_clear": [
                            "vdb_entities.json",
                            "vdb_relationships.json",
                            "vdb_chunks.json",
                            "kv_store_text_chunks.json",
                            "kv_store_full_docs.json",
                            "kv_store_doc_status.json",
                            "graph_chunk_entity_relation.graphml",
                        ],
                    },
                )

            # Perform destructive wipe BEFORE writing overlay
            try:
                wipe = await clear_indexed_data(
                    Path(rag.working_dir) if getattr(rag, "working_dir", "") else overlay_path.parent,
                    getattr(rag, "workspace", "") or "",
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=500,
                    detail={"error": "apply_failed", "stage": "clear", "detail": str(exc)},
                )

            if wipe["failed"]:
                raise HTTPException(
                    status_code=500,
                    detail={
                        "error": "clear_incomplete",
                        "deleted": wipe["deleted"],
                        "failed": wipe["failed"],
                    },
                )

            _apply_all_to_args(args, new)
            new_gen = save_runtime_overlay(overlay_path, new)
            return {
                "status": "restart_required",
                "reason": "embedding_rebuild",
                "generation": new_gen,
                "deleted": wipe["deleted"],
            }

        # Hot-swap path.
        try:
            await apply_hot(rag, new, args, factories, diff)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail={"error": "apply_failed", "stage": "factory", "detail": str(exc)},
            )

        new_gen = save_runtime_overlay(overlay_path, new)
        return {"status": "applied", "generation": new_gen}


def _apply_all_to_args(args: argparse.Namespace, new: RuntimeConfig) -> None:
    """Used only on the destructive path — mutate args for all three sections."""
    from lightrag.api.llm_config_apply import (
        _apply_embedding_to_args,
        _apply_llm_to_args,
        _apply_rerank_to_args,
    )
    _apply_llm_to_args(args, new.llm)
    _apply_embedding_to_args(args, new.embedding)
    _apply_rerank_to_args(args, new.rerank)
