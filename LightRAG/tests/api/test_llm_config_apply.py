import pytest

from lightrag.api.runtime_config import RuntimeConfig, SectionConfig
from lightrag.api.llm_config_apply import DiffKind, classify_diff


def _cfg(**overrides) -> RuntimeConfig:
    base = RuntimeConfig(
        generation=1,
        llm=SectionConfig(
            binding="openai", host="https://api.openai.com/v1", model="gpt-4o-mini",
            api_key="k", max_async=4, timeout=180, temperature=0.7, max_tokens=16384,
        ),
        embedding=SectionConfig(
            binding="openai", host="https://api.openai.com/v1",
            model="text-embedding-3-small", api_key="k",
            dim=1536, token_limit=8192, send_dim=False, timeout=30,
        ),
        rerank=SectionConfig(
            enabled=False, binding="null", host=None, model=None, api_key=None,
        ),
    )
    for path, value in overrides.items():
        section, field = path.split(".")
        setattr(getattr(base, section), field, value)
    return base


def test_no_change_is_none():
    assert classify_diff(_cfg(), _cfg()) == DiffKind.NONE


def test_llm_model_change_is_llm_only():
    new = _cfg(**{"llm.model": "gpt-4o"})
    assert classify_diff(_cfg(), new) == DiffKind.LLM_ONLY


def test_llm_api_key_change_is_llm_only():
    new = _cfg(**{"llm.api_key": "new-key"})
    assert classify_diff(_cfg(), new) == DiffKind.LLM_ONLY


def test_rerank_enabled_change_is_rerank_only():
    new = _cfg(**{"rerank.enabled": True, "rerank.binding": "jina"})
    assert classify_diff(_cfg(), new) == DiffKind.RERANK_ONLY


def test_embedding_host_only_is_safe():
    new = _cfg(**{"embedding.host": "https://api.deepseek.com/v1"})
    assert classify_diff(_cfg(), new) == DiffKind.EMBEDDING_HOST_ONLY


def test_embedding_key_only_is_safe():
    new = _cfg(**{"embedding.api_key": "new-embed-key"})
    assert classify_diff(_cfg(), new) == DiffKind.EMBEDDING_HOST_ONLY


def test_embedding_timeout_only_is_safe():
    new = _cfg(**{"embedding.timeout": 90})
    assert classify_diff(_cfg(), new) == DiffKind.EMBEDDING_HOST_ONLY


def test_embedding_model_change_is_rebuild():
    new = _cfg(**{"embedding.model": "text-embedding-3-large", "embedding.dim": 3072})
    assert classify_diff(_cfg(), new) == DiffKind.EMBEDDING_REBUILD


def test_embedding_dim_change_is_rebuild():
    new = _cfg(**{"embedding.dim": 2048})
    assert classify_diff(_cfg(), new) == DiffKind.EMBEDDING_REBUILD


def test_embedding_binding_change_is_rebuild():
    new = _cfg(**{"embedding.binding": "jina", "embedding.dim": 2048})
    assert classify_diff(_cfg(), new) == DiffKind.EMBEDDING_REBUILD


def test_llm_plus_rerank_is_multiple_hot():
    new = _cfg(**{"llm.model": "gpt-4o", "rerank.enabled": True, "rerank.binding": "jina"})
    assert classify_diff(_cfg(), new) == DiffKind.MULTIPLE_HOT


def test_llm_plus_embedding_rebuild_is_multiple_with_rebuild():
    new = _cfg(**{"llm.model": "gpt-4o", "embedding.dim": 3072})
    assert classify_diff(_cfg(), new) == DiffKind.MULTIPLE_WITH_REBUILD


# ─── apply_hot ──────────────────────────────────────────────────────────────

import argparse
from dataclasses import dataclass
from typing import Any
from lightrag.api.llm_config_apply import FactoryBundle, apply_hot


@dataclass
class _FakeRag:
    llm_model_func: Any = None
    llm_model_kwargs: Any = None
    embedding_func: Any = None
    rerank_model_func: Any = None


def _bundle(
    *,
    llm_result="llm-v2",
    llm_kwargs=None,
    embedding_result="embed-v2",
    rerank_result="rerank-v2",
    raise_on=None,
) -> FactoryBundle:
    llm_kwargs = llm_kwargs or {}

    def make_llm_func():
        if raise_on == "llm":
            raise RuntimeError("llm factory boom")
        return llm_result

    def make_llm_kwargs():
        return dict(llm_kwargs)

    def make_embedding_func():
        if raise_on == "embedding":
            raise RuntimeError("embedding factory boom")
        return embedding_result

    def make_rerank_func():
        if raise_on == "rerank":
            raise RuntimeError("rerank factory boom")
        return rerank_result

    return FactoryBundle(
        make_llm_func=make_llm_func,
        make_llm_kwargs=make_llm_kwargs,
        make_embedding_func=make_embedding_func,
        make_rerank_func=make_rerank_func,
    )


def _args_from_cfg(cfg: RuntimeConfig) -> argparse.Namespace:
    ns = argparse.Namespace()
    ns.llm_binding = cfg.llm.binding
    ns.llm_binding_host = cfg.llm.host
    ns.llm_binding_api_key = cfg.llm.api_key
    ns.llm_model = cfg.llm.model
    ns.llm_timeout = cfg.llm.timeout
    ns.max_async = cfg.llm.max_async
    ns.openai_llm_temperature = cfg.llm.temperature
    ns.openai_llm_max_tokens = cfg.llm.max_tokens
    ns.embedding_binding = cfg.embedding.binding
    ns.embedding_binding_host = cfg.embedding.host
    ns.embedding_binding_api_key = cfg.embedding.api_key
    ns.embedding_model = cfg.embedding.model
    ns.embedding_dim = cfg.embedding.dim
    ns.embedding_token_limit = cfg.embedding.token_limit
    ns.embedding_send_dim = cfg.embedding.send_dim
    ns.embedding_timeout = cfg.embedding.timeout
    ns.rerank_binding = cfg.rerank.binding or "null"
    ns.rerank_binding_host = cfg.rerank.host
    ns.rerank_binding_api_key = cfg.rerank.api_key
    ns.rerank_model = cfg.rerank.model
    return ns


@pytest.mark.asyncio
async def test_apply_hot_llm_only_mutates_llm_attr_only():
    rag = _FakeRag(llm_model_func="llm-v1", embedding_func="embed-v1", rerank_model_func="rerank-v1")
    args = _args_from_cfg(_cfg())
    new = _cfg(**{"llm.model": "gpt-4o"})
    await apply_hot(rag, new, args, _bundle(), DiffKind.LLM_ONLY)
    assert rag.llm_model_func == "llm-v2"
    assert rag.embedding_func == "embed-v1"
    assert rag.rerank_model_func == "rerank-v1"
    assert args.llm_model == "gpt-4o"


@pytest.mark.asyncio
async def test_apply_hot_rerank_only_updates_rerank_only():
    rag = _FakeRag(llm_model_func="llm-v1", embedding_func="embed-v1", rerank_model_func=None)
    args = _args_from_cfg(_cfg())
    new = _cfg(**{"rerank.enabled": True, "rerank.binding": "jina",
                  "rerank.host": "https://api.jina.ai/v1", "rerank.model": "rv2",
                  "rerank.api_key": "jk"})
    await apply_hot(rag, new, args, _bundle(rerank_result="jina-func"), DiffKind.RERANK_ONLY)
    assert rag.rerank_model_func == "jina-func"
    assert rag.llm_model_func == "llm-v1"
    assert args.rerank_binding == "jina"


@pytest.mark.asyncio
async def test_apply_hot_embedding_host_only_updates_embedding():
    rag = _FakeRag(llm_model_func="llm-v1", embedding_func="embed-v1", rerank_model_func=None)
    args = _args_from_cfg(_cfg())
    new = _cfg(**{"embedding.host": "https://api.deepseek.com/v1"})
    await apply_hot(rag, new, args, _bundle(), DiffKind.EMBEDDING_HOST_ONLY)
    assert rag.embedding_func == "embed-v2"
    assert args.embedding_binding_host == "https://api.deepseek.com/v1"


@pytest.mark.asyncio
async def test_apply_hot_multiple_hot_updates_all_changed():
    rag = _FakeRag(llm_model_func="llm-v1", embedding_func="embed-v1", rerank_model_func="rerank-v1")
    args = _args_from_cfg(_cfg())
    new = _cfg(**{"llm.model": "gpt-4o", "rerank.enabled": True, "rerank.binding": "jina"})
    await apply_hot(rag, new, args, _bundle(), DiffKind.MULTIPLE_HOT)
    assert rag.llm_model_func == "llm-v2"
    assert rag.rerank_model_func == "rerank-v2"
    assert rag.embedding_func == "embed-v1"  # untouched


@pytest.mark.asyncio
async def test_apply_hot_rejects_rebuild_diff():
    rag = _FakeRag()
    args = _args_from_cfg(_cfg())
    new = _cfg(**{"embedding.dim": 3072})
    with pytest.raises(ValueError, match="destructive"):
        await apply_hot(rag, new, args, _bundle(), DiffKind.EMBEDDING_REBUILD)


@pytest.mark.asyncio
async def test_apply_hot_rollback_on_factory_failure():
    """Factory raises after args were mutated → args and rag must roll back."""
    rag = _FakeRag(llm_model_func="llm-v1", embedding_func="embed-v1", rerank_model_func="rerank-v1")
    orig_cfg = _cfg()
    args = _args_from_cfg(orig_cfg)
    old_model = args.llm_model
    new = _cfg(**{"llm.model": "gpt-4o"})
    with pytest.raises(RuntimeError, match="llm factory boom"):
        await apply_hot(rag, new, args, _bundle(raise_on="llm"), DiffKind.LLM_ONLY)
    # rag pointer unchanged
    assert rag.llm_model_func == "llm-v1"
    # args rolled back to the original model
    assert args.llm_model == old_model


# ─── clear_indexed_data ─────────────────────────────────────────────────────

from lightrag.api.llm_config_apply import clear_indexed_data


@pytest.mark.asyncio
async def test_clear_indexed_data_default_workspace(tmp_path):
    working = tmp_path / "rag_storage"
    working.mkdir()

    # Create the canonical on-disk artifacts for a default-workspace instance.
    artifacts = [
        "vdb_entities.json",
        "vdb_relationships.json",
        "vdb_chunks.json",
        "kv_store_text_chunks.json",
        "kv_store_full_docs.json",
        "kv_store_doc_status.json",
        "graph_chunk_entity_relation.graphml",
    ]
    for name in artifacts:
        (working / name).write_text("{}")
    # LLM cache should be preserved
    (working / "kv_store_llm_response_cache.json").write_text("{}")
    # Unrelated file should be untouched.
    (working / "README").write_text("hello")

    result = await clear_indexed_data(working, workspace="")

    for name in artifacts:
        assert not (working / name).exists(), f"expected {name} removed"
    assert (working / "kv_store_llm_response_cache.json").exists()
    assert (working / "README").exists()
    assert set(result["deleted"]) == set(artifacts)
    assert result["failed"] == []


@pytest.mark.asyncio
async def test_clear_indexed_data_with_workspace_subdir(tmp_path):
    working = tmp_path / "rag_storage"
    sub = working / "tenant_a"
    sub.mkdir(parents=True)
    (sub / "vdb_entities.json").write_text("{}")
    (sub / "graph_chunk_entity_relation.graphml").write_text("{}")
    # Default workspace artifacts that must NOT be touched
    (working / "vdb_entities.json").write_text("{}")

    result = await clear_indexed_data(working, workspace="tenant_a")

    assert not (sub / "vdb_entities.json").exists()
    assert not (sub / "graph_chunk_entity_relation.graphml").exists()
    # Default workspace preserved
    assert (working / "vdb_entities.json").exists()


@pytest.mark.asyncio
async def test_clear_indexed_data_reports_missing_as_no_op(tmp_path):
    working = tmp_path / "rag_storage"
    working.mkdir()
    result = await clear_indexed_data(working, workspace="")
    assert result["deleted"] == []
    assert result["failed"] == []
