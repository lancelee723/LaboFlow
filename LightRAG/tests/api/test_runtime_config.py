import argparse
import json
import os
from pathlib import Path

import pytest

from lightrag.api.runtime_config import (
    RUNTIME_OVERLAY_WHITELIST,
    load_runtime_overlay,
    save_runtime_overlay,
    mask_key,
    unmask_or_keep,
    RuntimeConfig,
    SectionConfig,
)


def _empty_args() -> argparse.Namespace:
    ns = argparse.Namespace()
    # LLM
    ns.llm_binding = "openai"
    ns.llm_binding_host = "https://api.openai.com/v1"
    ns.llm_binding_api_key = "env-key"
    ns.llm_model = "gpt-4o-mini"
    ns.llm_timeout = 180
    ns.max_async = 4
    ns.openai_llm_temperature = 0.7
    ns.openai_llm_max_tokens = 16384
    # Embedding
    ns.embedding_binding = "openai"
    ns.embedding_binding_host = "https://api.openai.com/v1"
    ns.embedding_binding_api_key = "env-key"
    ns.embedding_model = "text-embedding-3-small"
    ns.embedding_dim = 1536
    ns.embedding_token_limit = 8192
    ns.embedding_send_dim = False
    ns.embedding_timeout = 30
    # Rerank
    ns.rerank_binding = "null"
    ns.rerank_binding_host = None
    ns.rerank_binding_api_key = None
    ns.rerank_model = None
    return ns


def test_load_missing_file_is_noop(tmp_path):
    args = _empty_args()
    before = vars(args).copy()
    load_runtime_overlay(args, tmp_path / "missing.json")
    assert vars(args) == before


def test_load_merges_whitelisted_fields(tmp_path):
    overlay = {
        "generation": 1,
        "updated_at": "2026-04-11T00:00:00Z",
        "llm": {
            "binding": "openai",
            "host": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
            "api_key": "sk-real",
            "max_async": 8,
            "timeout": 240,
            "temperature": 0.3,
            "max_tokens": 9000,
        },
        "embedding": {
            "binding": "openai",
            "host": "https://api.openai.com/v1",
            "model": "text-embedding-3-large",
            "api_key": "sk-embed",
            "dim": 3072,
            "token_limit": 8192,
            "send_dim": False,
            "timeout": 30,
        },
        "rerank": {
            "enabled": True,
            "binding": "jina",
            "host": "https://api.jina.ai/v1",
            "model": "jina-reranker-v2-base-multilingual",
            "api_key": "jina-key",
        },
    }
    path = tmp_path / "runtime_config.json"
    path.write_text(json.dumps(overlay))
    args = _empty_args()
    load_runtime_overlay(args, path)

    assert args.llm_binding_host == "https://api.deepseek.com/v1"
    assert args.llm_model == "deepseek-chat"
    assert args.llm_binding_api_key == "sk-real"
    assert args.max_async == 8
    assert args.llm_timeout == 240
    assert args.openai_llm_temperature == 0.3
    assert args.openai_llm_max_tokens == 9000
    assert args.embedding_model == "text-embedding-3-large"
    assert args.embedding_dim == 3072
    assert args.rerank_binding == "jina"
    assert args.rerank_binding_api_key == "jina-key"


def test_load_ignores_unknown_fields(tmp_path):
    overlay = {
        "generation": 1,
        "llm": {"binding": "openai", "evil_field": "boom"},
        "embedding": {},
        "rerank": {},
    }
    path = tmp_path / "runtime_config.json"
    path.write_text(json.dumps(overlay))
    args = _empty_args()
    load_runtime_overlay(args, path)
    assert not hasattr(args, "evil_field")


def test_save_is_atomic_and_increments_generation(tmp_path):
    path = tmp_path / "runtime_config.json"
    cfg = RuntimeConfig(
        generation=0,
        llm=SectionConfig(binding="openai", host="https://x", model="m", api_key="k",
                          max_async=4, timeout=180, temperature=0.7, max_tokens=4096),
        embedding=SectionConfig(binding="openai", host="https://x", model="m", api_key="k",
                                dim=1536, token_limit=8192, send_dim=False, timeout=30),
        rerank=SectionConfig(enabled=False, binding="null", host=None, model=None, api_key=None),
    )
    new_gen = save_runtime_overlay(path, cfg)
    assert new_gen == 1
    data = json.loads(path.read_text())
    assert data["generation"] == 1
    assert "updated_at" in data
    assert data["llm"]["binding"] == "openai"

    # File mode 0600
    mode = path.stat().st_mode & 0o777
    assert mode == 0o600

    # Second save increments
    cfg.generation = 1
    new_gen = save_runtime_overlay(path, cfg)
    assert new_gen == 2


def test_save_does_not_leave_tmpfile_on_success(tmp_path):
    path = tmp_path / "runtime_config.json"
    cfg = RuntimeConfig(
        generation=0,
        llm=SectionConfig(binding="openai", host="https://x", model="m", api_key="k",
                          max_async=4, timeout=180, temperature=0.7, max_tokens=4096),
        embedding=SectionConfig(binding="openai", host="https://x", model="m", api_key="k",
                                dim=1536, token_limit=8192, send_dim=False, timeout=30),
        rerank=SectionConfig(enabled=False, binding="null", host=None, model=None, api_key=None),
    )
    save_runtime_overlay(path, cfg)
    tmp = path.with_suffix(path.suffix + ".tmp")
    assert not tmp.exists()


def test_mask_key_short_and_empty():
    assert mask_key("") == ""
    assert mask_key("abc") == "••••"
    assert mask_key("abcdefgh") == "abcd••••gh"
    assert mask_key("sk-proj-abcdefghij12") == "sk-p••••12"


def test_unmask_or_keep_sentinel():
    real = "sk-proj-abcdefghij12"
    mask = mask_key(real)
    # Same mask string → keep real key
    assert unmask_or_keep(mask, real) == real
    # Different string → new key
    assert unmask_or_keep("sk-new-real-key-xxxx", real) == "sk-new-real-key-xxxx"
    # Empty submitted → empty (user cleared the field)
    assert unmask_or_keep("", real) == ""


def test_whitelist_contents():
    assert "binding" in RUNTIME_OVERLAY_WHITELIST["llm"]
    assert "api_key" in RUNTIME_OVERLAY_WHITELIST["llm"]
    assert "dim" in RUNTIME_OVERLAY_WHITELIST["embedding"]
    assert "enabled" in RUNTIME_OVERLAY_WHITELIST["rerank"]
    assert "working_dir" not in RUNTIME_OVERLAY_WHITELIST.get("llm", set())
