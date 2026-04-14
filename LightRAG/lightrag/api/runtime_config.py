"""Runtime config overlay for LightRAG.

Loads a JSON file from the working directory that overlays `.env`/argparse
defaults. Designed so startup is a no-op when the file doesn't exist — existing
`.env` behavior is unchanged.

Field names in the overlay use a nested/human shape:

    { "llm": {"binding": "openai", "host": "...", "model": "...", ...}, ... }

…and are flattened onto argparse attribute names (`llm_binding`,
`llm_binding_host`, `llm_model`, `openai_llm_temperature`, …) by
`load_runtime_overlay`. Keep both sides of the mapping in one place in this
module so the naming convention has exactly one owner.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# Fields that the overlay is allowed to override. Any other key is ignored
# during load, even if present on disk.
RUNTIME_OVERLAY_WHITELIST: dict[str, set[str]] = {
    "llm": {
        "binding", "host", "model", "api_key",
        "max_async", "timeout", "temperature", "max_tokens",
    },
    "embedding": {
        "binding", "host", "model", "api_key",
        "dim", "token_limit", "send_dim", "timeout",
    },
    "rerank": {
        "enabled", "binding", "host", "model", "api_key",
    },
}


# Mapping from overlay nested shape → argparse attribute names.
#   (section, field) → args attribute
_FIELD_TO_ARG: dict[tuple[str, str], str] = {
    ("llm", "binding"):     "llm_binding",
    ("llm", "host"):        "llm_binding_host",
    ("llm", "model"):       "llm_model",
    ("llm", "api_key"):     "llm_binding_api_key",
    ("llm", "max_async"):   "max_async",
    ("llm", "timeout"):     "llm_timeout",
    ("llm", "temperature"): "openai_llm_temperature",
    ("llm", "max_tokens"):  "openai_llm_max_tokens",

    ("embedding", "binding"):     "embedding_binding",
    ("embedding", "host"):        "embedding_binding_host",
    ("embedding", "model"):       "embedding_model",
    ("embedding", "api_key"):     "embedding_binding_api_key",
    ("embedding", "dim"):         "embedding_dim",
    ("embedding", "token_limit"): "embedding_token_limit",
    ("embedding", "send_dim"):    "embedding_send_dim",
    ("embedding", "timeout"):     "embedding_timeout",

    ("rerank", "binding"):  "rerank_binding",
    ("rerank", "host"):     "rerank_binding_host",
    ("rerank", "model"):    "rerank_model",
    ("rerank", "api_key"):  "rerank_binding_api_key",
    # 'enabled' is derived from rerank_binding != "null"; not mirrored on args.
}


@dataclass
class SectionConfig:
    # Union of all possible fields across sections. Unused fields stay None.
    binding: Optional[str] = None
    host: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    # LLM
    max_async: Optional[int] = None
    timeout: Optional[int] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    # Embedding
    dim: Optional[int] = None
    token_limit: Optional[int] = None
    send_dim: Optional[bool] = None
    # Rerank
    enabled: Optional[bool] = None


@dataclass
class RuntimeConfig:
    generation: int
    llm: SectionConfig = field(default_factory=SectionConfig)
    embedding: SectionConfig = field(default_factory=SectionConfig)
    rerank: SectionConfig = field(default_factory=SectionConfig)
    updated_at: Optional[str] = None


def load_runtime_overlay(args: argparse.Namespace, path: Path) -> None:
    """Merge `path` into `args` in place. Silent no-op if the file doesn't
    exist. Unknown fields are ignored."""
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        # Corrupt overlay → ignore silently rather than crash the server.
        return

    for section, whitelist in RUNTIME_OVERLAY_WHITELIST.items():
        section_data = data.get(section) or {}
        if not isinstance(section_data, dict):
            continue
        for key, value in section_data.items():
            if key not in whitelist:
                continue
            arg_attr = _FIELD_TO_ARG.get((section, key))
            if arg_attr is None:
                continue
            if key == "binding" and isinstance(value, str) and not value:
                value = "null"
            setattr(args, arg_attr, value)


def save_runtime_overlay(path: Path, cfg: RuntimeConfig) -> int:
    """Atomic write: write to `<path>.tmp`, fsync, rename. Increments and
    returns the new generation. File is created with mode 0600."""
    cfg.generation += 1
    cfg.updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    payload = {
        "generation": cfg.generation,
        "updated_at": cfg.updated_at,
        "llm": _section_to_json(cfg.llm, RUNTIME_OVERLAY_WHITELIST["llm"]),
        "embedding": _section_to_json(cfg.embedding, RUNTIME_OVERLAY_WHITELIST["embedding"]),
        "rerank": _section_to_json(cfg.rerank, RUNTIME_OVERLAY_WHITELIST["rerank"]),
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    # Write with 0600 permission from the start.
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        # Clean up orphaned tmp file on failure, then re-raise.
        try:
            tmp_path.unlink(missing_ok=True)
        finally:
            raise
    # Ensure 0600 even if umask was permissive or file pre-existed.
    os.chmod(path, 0o600)
    return cfg.generation


def _section_to_json(section: SectionConfig, whitelist: set[str]) -> dict:
    raw = asdict(section)
    return {k: v for k, v in raw.items() if k in whitelist and v is not None}


def mask_key(key: str) -> str:
    """'' → '';  len<8 → '••••';  len≥8 → key[:4] + '••••' + key[-2:]."""
    if not key:
        return ""
    if len(key) < 8:
        return "••••"
    return key[:4] + "••••" + key[-2:]


def unmask_or_keep(submitted: str, existing: str) -> str:
    """Sentinel check. If the submitted value equals the mask of `existing`,
    the user didn't touch the field — return `existing`. Otherwise treat the
    submitted string as a new real key (including '' which means 'cleared')."""
    if existing and submitted == mask_key(existing):
        return existing
    return submitted
