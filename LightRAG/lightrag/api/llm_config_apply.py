"""Apply-layer helpers for the LLM provider settings feature.

Knows about:
  - comparing two RuntimeConfig objects and classifying the diff
  - rebuilding llm/embedding/rerank functions by mutating `args` then calling
    the factories captured in a `FactoryBundle`
  - clearing indexed data when a destructive embedding change is confirmed

Does NOT know about:
  - FastAPI, pydantic, HTTP, authentication
  - the layout of runtime_config.json on disk (that's runtime_config.py)

Keeping this module HTTP-agnostic lets us unit-test hot-swap against a fake
`rag` dataclass without spinning up uvicorn.
"""

from __future__ import annotations

import argparse
import enum
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from lightrag.api.runtime_config import RuntimeConfig, SectionConfig


class DiffKind(str, enum.Enum):
    NONE = "none"
    LLM_ONLY = "llm_only"
    RERANK_ONLY = "rerank_only"
    EMBEDDING_HOST_ONLY = "embedding_host_only"  # host / api_key / timeout — safe
    EMBEDDING_REBUILD = "embedding_rebuild"      # binding / model / dim  — destructive
    MULTIPLE_HOT = "multiple_hot"                # any combination of hot-safe changes
    MULTIPLE_WITH_REBUILD = "multiple_with_rebuild"  # hot + destructive


# Fields on the embedding section that are safe to change without a rebuild.
_EMBEDDING_HOT_FIELDS: frozenset[str] = frozenset({"host", "api_key", "timeout"})

# Fields on the embedding section that force a destructive rebuild.
_EMBEDDING_REBUILD_FIELDS: frozenset[str] = frozenset({"binding", "model", "dim"})


def _section_differs(
    old: SectionConfig,
    new: SectionConfig,
    fields: frozenset[str],
) -> bool:
    return any(getattr(old, f) != getattr(new, f) for f in fields)


def _any_field_differs(old: SectionConfig, new: SectionConfig) -> bool:
    for field_name in vars(old):
        if getattr(old, field_name) != getattr(new, field_name):
            return True
    return False


def classify_diff(old: RuntimeConfig, new: RuntimeConfig) -> DiffKind:
    """Return the minimum required action for the transition from `old` to
    `new`. Order matters: destructive classifications short-circuit."""

    llm_changed = _any_field_differs(old.llm, new.llm)
    rerank_changed = _any_field_differs(old.rerank, new.rerank)

    embed_rebuild = _section_differs(old.embedding, new.embedding, _EMBEDDING_REBUILD_FIELDS)
    embed_hot = _section_differs(old.embedding, new.embedding, _EMBEDDING_HOT_FIELDS)

    if embed_rebuild:
        if llm_changed or rerank_changed or embed_hot:
            return DiffKind.MULTIPLE_WITH_REBUILD
        return DiffKind.EMBEDDING_REBUILD

    hot_count = sum(
        1 for changed in (llm_changed, rerank_changed, embed_hot) if changed
    )
    if hot_count == 0:
        return DiffKind.NONE
    if hot_count > 1:
        return DiffKind.MULTIPLE_HOT
    if llm_changed:
        return DiffKind.LLM_ONLY
    if rerank_changed:
        return DiffKind.RERANK_ONLY
    return DiffKind.EMBEDDING_HOST_ONLY


# ─── Apply ──────────────────────────────────────────────────────────────────


@dataclass
class FactoryBundle:
    """Callables captured from `get_application()` in `lightrag_server.py`.

    Each callable closes over `args` (and `config_cache` / `llm_timeout`) from
    the outer function. The HTTP router mutates `args` attributes in place
    before invoking these, so the returned values reflect the new config.
    """
    make_llm_func: Callable[[], Any]
    make_llm_kwargs: Callable[[], dict]
    make_embedding_func: Callable[[], Any]
    make_rerank_func: Callable[[], Any]  # may return None when disabled


# Sections of `args` that each section of the diff touches, so we can snapshot
# and roll back on factory failure.
_LLM_ARG_ATTRS = (
    "llm_binding", "llm_binding_host", "llm_binding_api_key", "llm_model",
    "llm_timeout", "max_async", "openai_llm_temperature", "openai_llm_max_tokens",
)
_EMBEDDING_ARG_ATTRS = (
    "embedding_binding", "embedding_binding_host", "embedding_binding_api_key",
    "embedding_model", "embedding_dim", "embedding_token_limit",
    "embedding_send_dim", "embedding_timeout",
)
_RERANK_ARG_ATTRS = (
    "rerank_binding", "rerank_binding_host", "rerank_binding_api_key", "rerank_model",
)


def _snapshot(args: argparse.Namespace, attrs: tuple[str, ...]) -> dict:
    return {name: getattr(args, name, None) for name in attrs}


def _restore(args: argparse.Namespace, snap: dict) -> None:
    for name, value in snap.items():
        setattr(args, name, value)


def _apply_llm_to_args(args: argparse.Namespace, section: SectionConfig) -> None:
    args.llm_binding = section.binding
    args.llm_binding_host = section.host
    args.llm_binding_api_key = section.api_key
    args.llm_model = section.model
    if section.max_async is not None:
        args.max_async = section.max_async
    if section.timeout is not None:
        args.llm_timeout = section.timeout
    if section.temperature is not None:
        args.openai_llm_temperature = section.temperature
    if section.max_tokens is not None:
        args.openai_llm_max_tokens = section.max_tokens


def _apply_embedding_to_args(args: argparse.Namespace, section: SectionConfig) -> None:
    args.embedding_binding = section.binding
    args.embedding_binding_host = section.host
    args.embedding_binding_api_key = section.api_key
    args.embedding_model = section.model
    if section.dim is not None:
        args.embedding_dim = section.dim
    if section.token_limit is not None:
        args.embedding_token_limit = section.token_limit
    if section.send_dim is not None:
        args.embedding_send_dim = section.send_dim
    if section.timeout is not None:
        args.embedding_timeout = section.timeout


def _apply_rerank_to_args(args: argparse.Namespace, section: SectionConfig) -> None:
    if section.enabled is False:
        args.rerank_binding = "null"
        args.rerank_binding_host = None
        args.rerank_binding_api_key = None
        args.rerank_model = None
        return
    args.rerank_binding = section.binding or "null"
    args.rerank_binding_host = section.host
    args.rerank_binding_api_key = section.api_key
    args.rerank_model = section.model


_HOT_DIFF_KINDS: frozenset[DiffKind] = frozenset({
    DiffKind.NONE,
    DiffKind.LLM_ONLY,
    DiffKind.RERANK_ONLY,
    DiffKind.EMBEDDING_HOST_ONLY,
    DiffKind.MULTIPLE_HOT,
})


async def apply_hot(
    rag: Any,
    new: RuntimeConfig,
    args: argparse.Namespace,
    factories: FactoryBundle,
    diff: DiffKind,
) -> None:
    """Rebuild the factories that changed and assign them to `rag.*`.

    Semantics:
      - The caller MUST hold the config lock.
      - On success, `args` and `rag.*` both reflect `new`.
      - On factory failure, `args` and `rag.*` are both restored to pre-call
        state and the underlying exception is re-raised.
      - Rejects destructive diffs (caller must take the rebuild path).
    """
    if diff not in _HOT_DIFF_KINDS:
        raise ValueError(f"apply_hot called with destructive diff {diff.value}")

    touch_llm = diff in (DiffKind.LLM_ONLY, DiffKind.MULTIPLE_HOT)
    touch_rerank = diff in (DiffKind.RERANK_ONLY, DiffKind.MULTIPLE_HOT)
    touch_embed = diff in (DiffKind.EMBEDDING_HOST_ONLY,)

    # For MULTIPLE_HOT, only touch embedding if its hot fields actually changed
    # (e.g. llm+rerank change should NOT rebuild the embedding func).
    if diff == DiffKind.MULTIPLE_HOT:
        old_embed = SectionConfig(
            binding=getattr(args, "embedding_binding", None),
            host=getattr(args, "embedding_binding_host", None),
            api_key=getattr(args, "embedding_binding_api_key", None),
            timeout=getattr(args, "embedding_timeout", None),
        )
        touch_embed = _section_differs(old_embed, new.embedding, _EMBEDDING_HOT_FIELDS)

    llm_snap = _snapshot(args, _LLM_ARG_ATTRS) if touch_llm else None
    rerank_snap = _snapshot(args, _RERANK_ARG_ATTRS) if touch_rerank else None
    embed_snap = _snapshot(args, _EMBEDDING_ARG_ATTRS) if touch_embed else None

    # Build new callables *before* mutating rag. If any factory raises, roll
    # back args and leave rag untouched.
    try:
        new_llm = None
        new_llm_kwargs = None
        new_embedding = None
        new_rerank = None

        if touch_llm:
            _apply_llm_to_args(args, new.llm)
            new_llm = factories.make_llm_func()
            new_llm_kwargs = factories.make_llm_kwargs()

        if touch_embed:
            _apply_embedding_to_args(args, new.embedding)
            new_embedding = factories.make_embedding_func()

        if touch_rerank:
            _apply_rerank_to_args(args, new.rerank)
            new_rerank = factories.make_rerank_func()
    except Exception:
        if llm_snap is not None:
            _restore(args, llm_snap)
        if rerank_snap is not None:
            _restore(args, rerank_snap)
        if embed_snap is not None:
            _restore(args, embed_snap)
        raise

    # Assignments below are pure attribute writes and cannot fail; Python
    # attribute assignment is atomic from the caller's perspective.
    if touch_llm:
        rag.llm_model_func = new_llm
        # rag stores the llm kwargs as well (see LightRAG constructor in
        # lightrag_server.py). The field is named `llm_model_kwargs`.
        if hasattr(rag, "llm_model_kwargs"):
            rag.llm_model_kwargs = new_llm_kwargs
    if touch_embed:
        rag.embedding_func = new_embedding
    if touch_rerank:
        rag.rerank_model_func = new_rerank


# ─── Destructive: clear indexed data ────────────────────────────────────────

# Canonical JSON / GraphML artifacts written by the default file-backed
# storages (NanoVectorDB, JsonKV, NetworkX, JsonDocStatus). Each is unlinked
# during a destructive embedding rebuild. LLM response cache is intentionally
# NOT listed — it does not depend on embedding dimension and is useful to keep
# across rebuilds.
_CLEAR_TARGETS: tuple[str, ...] = (
    "vdb_entities.json",
    "vdb_relationships.json",
    "vdb_chunks.json",
    "kv_store_text_chunks.json",
    "kv_store_full_docs.json",
    "kv_store_doc_status.json",
    "graph_chunk_entity_relation.graphml",
)


async def clear_indexed_data(working_dir: Path, workspace: str) -> dict:
    """Unlink all file-backed storage artifacts for the given workspace.

    Caller is responsible for ensuring the `rag` instance has been finalized
    (or is otherwise not holding handles) before this runs — on POSIX we can
    delete open files, but the next `LightRAG(...)` boot should start from an
    empty slate with no stale in-memory copies.

    Returns `{"deleted": [...], "failed": [{"path": ..., "error": ...}]}`.

    This function only understands the default file-backed storages. Custom
    backends (Postgres, Neo4j, Qdrant, …) are the responsibility of the user
    and are out of scope for v1.
    """
    target_dir = working_dir / workspace if workspace else working_dir
    deleted: list[str] = []
    failed: list[dict] = []

    if not target_dir.exists():
        return {"deleted": deleted, "failed": failed}

    for name in _CLEAR_TARGETS:
        candidate = target_dir / name
        if not candidate.exists():
            continue
        try:
            candidate.unlink()
            deleted.append(name)
        except OSError as exc:
            failed.append({"path": str(candidate), "error": str(exc)})

    return {"deleted": deleted, "failed": failed}
