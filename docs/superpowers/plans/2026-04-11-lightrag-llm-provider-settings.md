# LightRAG LLM Provider Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-gated UI inside the LightRAG WebUI that lets a platform_admin edit LLM / Embedding / Rerank provider settings at runtime, persisting to an overlay JSON file and hot-swapping the running `rag` instance where safe.

**Architecture:** A runtime_config.json overlay is loaded at boot and merged into argparse before the existing factories build the LLM / embedding / rerank callables. A new FastAPI router (`/llm-config`) owns GET/POST for the overlay, is gated by a JWT role check, and — for hot-swappable diffs — invokes the same factories (now stashed on `app.state`) and assigns the results back onto the already-constructed `rag` instance. Destructive diffs (embedding binding/model/dim change) wipe indexed data and return `restart_required`. The WebUI gets a gear icon in `SiteHeader` that opens a dialog with three tabs.

**Tech Stack:** Python 3.11 / FastAPI / pydantic v2 / pytest. TypeScript / React 19 / Vite / @radix-ui/react-dialog / zustand / i18next / bun.

**Spec:** `docs/superpowers/specs/2026-04-11-lightrag-llm-provider-settings-design.md` — read this before starting. Every task below is anchored to a section in the spec.

---

## File Structure

**Create (backend):**
- `LightRAG/lightrag/api/runtime_config.py` — overlay I/O, whitelist, mask helpers
- `LightRAG/lightrag/api/llm_config_apply.py` — DiffKind, classify_diff, FactoryBundle, apply_hot, clear_indexed_data
- `LightRAG/lightrag/api/routers/llm_config_routes.py` — GET/POST `/llm-config`, `require_platform_admin`

**Modify (backend):**
- `LightRAG/lightrag/api/lightrag_server.py`:
  - Extract rerank block into `create_rerank_func(args)` helper
  - `load_runtime_overlay(args, overlay_path)` after `parse_args`
  - Patch `/sso-login` to forward `role` from Clawith JWT
  - Stash `rag`, `args`, `overlay_path`, `llm_config_lock`, `factories` on `app.state`
  - `app.include_router(llm_config_router)`

**Create (tests):**
- `LightRAG/tests/api/test_runtime_config.py`
- `LightRAG/tests/api/test_llm_config_apply.py`
- `LightRAG/tests/api/test_llm_config_routes.py`
- `LightRAG/tests/api/test_sso_role_forwarding.py`

**Create (frontend):**
- `LightRAG/lightrag_webui/src/api/llmConfig.ts` — typed client for `/llm-config`
- `LightRAG/lightrag_webui/src/lib/llmProviderPresets.ts` — OpenAI-compatible preset catalog
- `LightRAG/lightrag_webui/src/features/LLMConfigDialog/index.tsx`
- `LightRAG/lightrag_webui/src/features/LLMConfigDialog/LLMSection.tsx`
- `LightRAG/lightrag_webui/src/features/LLMConfigDialog/EmbeddingSection.tsx`
- `LightRAG/lightrag_webui/src/features/LLMConfigDialog/RerankSection.tsx`
- `LightRAG/lightrag_webui/src/features/LLMConfigDialog/DestructiveConfirm.tsx`
- `LightRAG/lightrag_webui/src/features/LLMConfigButton.tsx`

**Modify (frontend):**
- `LightRAG/lightrag_webui/src/stores/state.ts` — surface `role` on `useAuthStore`
- `LightRAG/lightrag_webui/src/features/SiteHeader.tsx` — mount `<LLMConfigButton />` between `<AppSettings />` and logout
- `LightRAG/lightrag_webui/src/locales/en.json` + `zh.json` — i18n keys for the dialog

---

## Ground rules

- **TDD**: For every backend task, write the failing test first, run it to confirm it fails, then implement. Frontend tests are bun component tests; same cycle.
- **Commit cadence**: One commit per task. Message prefix `feat(llm-config):`, `test(llm-config):`, `refactor(llm-config):`.
- **Run from `LightRAG/`**: All `pytest`, `python -m`, and `bun` commands are run from `/Users/lance/LaboFlow/LightRAG` (backend) or `/Users/lance/LaboFlow/LightRAG/lightrag_webui` (frontend).
- **Never mutate `rag.*` without the lock held.** Every mutation path goes through `apply_hot` with `app.state.llm_config_lock` acquired.
- **Never write the overlay before mutation succeeds.** Factory exceptions must leave disk and memory untouched.
- **Do not restart LightRAG from code.** Hot-swap is in-process; destructive path returns `restart_required`.

---

## Task 1: `runtime_config.py` — whitelist, mask helpers, load/save

**Files:**
- Create: `LightRAG/lightrag/api/runtime_config.py`
- Test: `LightRAG/tests/api/test_runtime_config.py`

Spec reference: §4.1, §5.1.

- [ ] **Step 1: Write the failing tests**

Create `LightRAG/tests/api/test_runtime_config.py`:

```python
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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_runtime_config.py -v
```

Expected: `ModuleNotFoundError: No module named 'lightrag.api.runtime_config'`.

- [ ] **Step 3: Create `runtime_config.py`**

Create `LightRAG/lightrag/api/runtime_config.py`:

```python
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
        # A warning is logged by the caller when appropriate.
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_runtime_config.py -v
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/runtime_config.py LightRAG/tests/api/test_runtime_config.py
git commit -m "feat(llm-config): add runtime_config overlay module with mask helpers"
```

Note: LaboFlow root is not a git repo but `LightRAG/` is a subrepo. If `git status` shows the changes as untracked in a different repo, commit there instead. If neither repo tracks the changes, ask the user how they want commits handled before continuing.

---

## Task 2: `llm_config_apply.py` — `DiffKind` and `classify_diff`

**Files:**
- Create: `LightRAG/lightrag/api/llm_config_apply.py`
- Test: `LightRAG/tests/api/test_llm_config_apply.py`

Spec reference: §2.2, §5.2.

- [ ] **Step 1: Write the failing tests**

Create `LightRAG/tests/api/test_llm_config_apply.py` (this file will be extended in later tasks; start with just the classifier tests):

```python
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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_apply.py -v
```

Expected: `ModuleNotFoundError: No module named 'lightrag.api.llm_config_apply'`.

- [ ] **Step 3: Create `llm_config_apply.py`**

Create `LightRAG/lightrag/api/llm_config_apply.py`:

```python
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
from typing import Any, Awaitable, Callable, Optional

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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_apply.py -v
```

Expected: all 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/llm_config_apply.py LightRAG/tests/api/test_llm_config_apply.py
git commit -m "feat(llm-config): add DiffKind classifier for overlay changes"
```

---

## Task 3: Extend `llm_config_apply.py` with `FactoryBundle` and `apply_hot`

**Files:**
- Modify: `LightRAG/lightrag/api/llm_config_apply.py`
- Modify: `LightRAG/tests/api/test_llm_config_apply.py` (append new tests)

Spec reference: §5.2, §5.4 step 4, §6.2.

- [ ] **Step 1: Append failing tests**

Append to `LightRAG/tests/api/test_llm_config_apply.py`:

```python
# ─── apply_hot ──────────────────────────────────────────────────────────────

import argparse
from dataclasses import dataclass
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
```

Add at the very top of `test_llm_config_apply.py` (adjacent to existing imports) if not present:

```python
pytestmark = pytest.mark.asyncio
```

Do NOT add `pytestmark` if it would apply to the synchronous `classify_diff` tests. Instead, use the `@pytest.mark.asyncio` decorator per-test as shown above. Ensure `pytest-asyncio` is available (it is already an indirect dev dep; if not, `pip install pytest-asyncio` inside the venv or add it to `test` extras via `uv add --dev pytest-asyncio`).

Verify by running `python -m pytest --collect-only tests/api/test_llm_config_apply.py` — all tests should collect without errors.

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_apply.py -v
```

Expected: `ImportError: cannot import name 'FactoryBundle' from 'lightrag.api.llm_config_apply'`.

- [ ] **Step 3: Extend `llm_config_apply.py`**

Append to `LightRAG/lightrag/api/llm_config_apply.py`:

```python
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
    touch_embed = diff in (DiffKind.EMBEDDING_HOST_ONLY, DiffKind.MULTIPLE_HOT)

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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_apply.py -v
```

Expected: all tests (classifier + apply_hot) PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/llm_config_apply.py LightRAG/tests/api/test_llm_config_apply.py
git commit -m "feat(llm-config): add FactoryBundle and apply_hot with rollback"
```

---

## Task 4: Extend `llm_config_apply.py` with `clear_indexed_data`

**Files:**
- Modify: `LightRAG/lightrag/api/llm_config_apply.py`
- Modify: `LightRAG/tests/api/test_llm_config_apply.py`

Spec reference: §2.2, §5.2, §6.3.

- [ ] **Step 1: Append failing tests**

Append to `LightRAG/tests/api/test_llm_config_apply.py`:

```python
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
    # LLM cache should be preserved (optional: we intentionally do NOT clear it).
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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_apply.py::test_clear_indexed_data_default_workspace -v
```

Expected: `ImportError: cannot import name 'clear_indexed_data' from 'lightrag.api.llm_config_apply'`.

- [ ] **Step 3: Implement `clear_indexed_data`**

Append to `LightRAG/lightrag/api/llm_config_apply.py`:

```python
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_apply.py -v
```

Expected: all tests in this file PASS (classifier + apply_hot + clear_indexed_data).

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/llm_config_apply.py LightRAG/tests/api/test_llm_config_apply.py
git commit -m "feat(llm-config): add clear_indexed_data for destructive rebuild"
```

---

## Task 5: Patch SSO to forward Clawith role

**Files:**
- Modify: `LightRAG/lightrag/api/lightrag_server.py` (sso_login handler, ~line 1213)
- Test: `LightRAG/tests/api/test_sso_role_forwarding.py`

Spec reference: §2.3, §5.4 step 3.

**Context:** The current `/sso-login` handler ignores the Clawith `role` claim and always issues a token with `role="user"`. Admin gating can't work until this is fixed.

- [ ] **Step 1: Write the failing tests**

Create `LightRAG/tests/api/test_sso_role_forwarding.py`:

```python
"""Validate that /sso-login preserves the Clawith `role` claim so the
`require_platform_admin` dependency in llm_config_routes can enforce
admin-only access."""

import os
import time

import jwt
import pytest
from fastapi.testclient import TestClient

# Ensure auth is configured with a known secret for the test so
# `auth_handler.validate_external_token` can verify our forged Clawith JWT.
os.environ.setdefault("TOKEN_SECRET", "test-secret-for-sso-role-forwarding")
os.environ.setdefault("AUTH_ACCOUNTS", "admin:adminpass")

from lightrag.api.auth import auth_handler  # noqa: E402


def _make_clawith_token(role: str) -> str:
    payload = {
        "sub": "user-uuid-12345678",
        "role": role,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, auth_handler.secret, algorithm=auth_handler.algorithm)


def _decode_lightrag_token(token: str) -> dict:
    return jwt.decode(token, auth_handler.secret, algorithms=[auth_handler.algorithm])


@pytest.fixture
def client():
    from lightrag.api.lightrag_server import get_application
    import argparse
    # get_application reads from global_args which is populated by parse_args.
    # For unit-testing the route only, we can mount a minimal app with just
    # the sso_login handler. Fall back to the full get_application if that
    # indirection is too expensive.
    from lightrag.api.config import global_args
    app = get_application(global_args)
    with TestClient(app) as c:
        yield c


def test_sso_login_forwards_platform_admin_role(client):
    token = _make_clawith_token(role="platform_admin")
    resp = client.post("/sso-login", json={"token": token})
    assert resp.status_code == 200, resp.text
    lightrag_token = resp.json()["access_token"]
    decoded = _decode_lightrag_token(lightrag_token)
    assert decoded["role"] == "platform_admin"


def test_sso_login_forwards_plain_user_role(client):
    token = _make_clawith_token(role="user")
    resp = client.post("/sso-login", json={"token": token})
    assert resp.status_code == 200, resp.text
    decoded = _decode_lightrag_token(resp.json()["access_token"])
    assert decoded["role"] == "user"


def test_sso_login_defaults_to_user_when_role_missing(client):
    payload = {
        "sub": "user-uuid-12345678",
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(payload, auth_handler.secret, algorithm=auth_handler.algorithm)
    resp = client.post("/sso-login", json={"token": token})
    assert resp.status_code == 200, resp.text
    decoded = _decode_lightrag_token(resp.json()["access_token"])
    assert decoded["role"] == "user"
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_sso_role_forwarding.py -v
```

Expected: `test_sso_login_forwards_platform_admin_role` FAILS because the handler hardcodes `role="user"`.

- [ ] **Step 3: Patch the handler**

In `LightRAG/lightrag/api/lightrag_server.py`, find the `sso_login` handler (currently around line 1213–1246). Replace the `create_token` call:

Old:

```python
        # Issue a LightRAG-native token
        lightrag_token = auth_handler.create_token(
            username=username,
            role="user",
            metadata={"sso": True, "clawith_user_id": user_id},
        )
```

New:

```python
        # Forward the Clawith role so downstream dependencies
        # (e.g. require_platform_admin) can enforce admin-only access.
        # Legacy tokens without a role claim default to "user".
        clawith_role = payload.get("role") or "user"
        lightrag_token = auth_handler.create_token(
            username=username,
            role=clawith_role,
            metadata={
                "sso": True,
                "clawith_user_id": user_id,
                "clawith_role": clawith_role,
            },
        )
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_sso_role_forwarding.py -v
```

Expected: all 3 tests PASS. If `get_application()` setup is too heavy for a unit test and you see import-time failures unrelated to the handler, narrow the test to import `sso_login` through a minimal FastAPI app mount — the handler only needs `auth_handler` and a JSON body.

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/lightrag_server.py LightRAG/tests/api/test_sso_role_forwarding.py
git commit -m "fix(sso): forward Clawith role claim into LightRAG-native token"
```

---

## Task 6: `llm_config_routes.py` — router, `require_platform_admin`, GET

**Files:**
- Create: `LightRAG/lightrag/api/routers/llm_config_routes.py`
- Test: `LightRAG/tests/api/test_llm_config_routes.py`

Spec reference: §4.2, §5.3, §5.4.

- [ ] **Step 1: Write the failing test for GET + auth matrix**

Create `LightRAG/tests/api/test_llm_config_routes.py`:

```python
"""Route tests for the LLM config surface.

These tests mount a minimal FastAPI app with the router, provide a fake
`rag`, fake factories, and a real `auth_handler`. We do NOT spin up the
real LightRAG server or touch storage.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("TOKEN_SECRET", "test-secret-for-llm-config-routes")
os.environ.setdefault("AUTH_ACCOUNTS", "admin:adminpass")

from lightrag.api.auth import auth_handler  # noqa: E402
from lightrag.api.llm_config_apply import FactoryBundle  # noqa: E402
from lightrag.api.routers.llm_config_routes import router as llm_config_router  # noqa: E402


@dataclass
class _FakeRag:
    llm_model_func: Any = "llm-v1"
    llm_model_kwargs: Any = None
    embedding_func: Any = "embed-v1"
    rerank_model_func: Any = None
    working_dir: str = ""
    workspace: str = ""

    @property
    def doc_status(self):
        class _S:
            async def get_status_counts(self):
                return {"processed": 0, "pending": 0, "failed": 0}
        return _S()


def _args() -> argparse.Namespace:
    ns = argparse.Namespace()
    ns.llm_binding = "openai"
    ns.llm_binding_host = "https://api.openai.com/v1"
    ns.llm_binding_api_key = "env-llm-key-abcdefghij"
    ns.llm_model = "gpt-4o-mini"
    ns.llm_timeout = 180
    ns.max_async = 4
    ns.openai_llm_temperature = 0.7
    ns.openai_llm_max_tokens = 16384
    ns.embedding_binding = "openai"
    ns.embedding_binding_host = "https://api.openai.com/v1"
    ns.embedding_binding_api_key = "env-embed-key-0123456789"
    ns.embedding_model = "text-embedding-3-small"
    ns.embedding_dim = 1536
    ns.embedding_token_limit = 8192
    ns.embedding_send_dim = False
    ns.embedding_timeout = 30
    ns.rerank_binding = "null"
    ns.rerank_binding_host = None
    ns.rerank_binding_api_key = None
    ns.rerank_model = None
    ns.working_dir = ""
    ns.workspace = ""
    return ns


@pytest.fixture
def tmp_overlay_path(tmp_path) -> Path:
    return tmp_path / "runtime_config.json"


@pytest.fixture
def app(tmp_overlay_path) -> FastAPI:
    app = FastAPI()
    app.include_router(llm_config_router)
    rag = _FakeRag(working_dir=str(tmp_overlay_path.parent))
    args = _args()
    tmp_overlay_path.parent.mkdir(parents=True, exist_ok=True)
    app.state.rag = rag
    app.state.args = args
    app.state.overlay_path = tmp_overlay_path
    app.state.llm_config_lock = asyncio.Lock()
    app.state.factories = FactoryBundle(
        make_llm_func=lambda: f"llm:{args.llm_model}",
        make_llm_kwargs=lambda: {},
        make_embedding_func=lambda: f"embed:{args.embedding_model}:{args.embedding_dim}",
        make_rerank_func=lambda: None if args.rerank_binding == "null" else f"rerank:{args.rerank_model}",
    )
    return app


@pytest.fixture
def admin_token() -> str:
    return auth_handler.create_token(username="admin", role="platform_admin")


@pytest.fixture
def user_token() -> str:
    return auth_handler.create_token(username="bob", role="user")


def test_get_llm_config_requires_auth(app):
    client = TestClient(app)
    resp = client.get("/llm-config")
    assert resp.status_code in (401, 403)


def test_get_llm_config_rejects_non_admin(app, user_token):
    client = TestClient(app)
    resp = client.get("/llm-config", headers={"Authorization": f"Bearer {user_token}"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "admin_required"


def test_get_llm_config_admin_returns_masked_keys(app, admin_token):
    client = TestClient(app)
    resp = client.get("/llm-config", headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["generation"] == 0
    assert body["llm"]["binding"] == "openai"
    assert body["llm"]["api_key_masked"].startswith("env-")
    assert "api_key" not in body["llm"]
    assert body["embedding"]["dim"] == 1536
    assert body["rerank"]["enabled"] is False
    assert "openai" in body["providers"]["llm_bindings"]
    assert "jina" in body["providers"]["embedding_bindings"]
    assert "aliyun" in body["providers"]["rerank_bindings"]
    assert body["has_indexed_data"] is False
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_routes.py -v
```

Expected: `ModuleNotFoundError: No module named 'lightrag.api.routers.llm_config_routes'`.

- [ ] **Step 3: Create the router**

Create `LightRAG/lightrag/api/routers/llm_config_routes.py`:

```python
"""FastAPI routes for runtime LLM provider configuration.

This is the only module that imports both `runtime_config` and
`llm_config_apply`. It also owns the apply lock and the pydantic request /
response models. Everything else is kept out of here so the two helper
modules can be tested offline.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field

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
            timeout=args.llm_timeout,
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
        import json
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

    # Which sections came from the overlay vs .env? Read file (if any) and
    # report per-section "overlay" if any whitelisted field is present.
    overlay_sections: set[str] = set()
    if overlay_path.exists():
        try:
            import json
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
            timeout=args.llm_timeout,
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
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_routes.py -v
```

Expected: the GET tests PASS. POST tests are added in Task 7.

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/routers/llm_config_routes.py LightRAG/tests/api/test_llm_config_routes.py
git commit -m "feat(llm-config): add GET /llm-config endpoint with admin gating"
```

---

## Task 7: Implement POST `/llm-config`

**Files:**
- Modify: `LightRAG/lightrag/api/routers/llm_config_routes.py`
- Modify: `LightRAG/tests/api/test_llm_config_routes.py`

Spec reference: §4.2, §5.3, §6.2, §6.3, §6.4.

- [ ] **Step 1: Append failing tests for POST**

Append to `LightRAG/tests/api/test_llm_config_routes.py`:

```python
# ─── POST /llm-config ───────────────────────────────────────────────────────


def _full_body(overrides: dict | None = None) -> dict:
    body = {
        "generation": 0,
        "force_clear": False,
        "llm": {
            "binding": "openai",
            "host": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
            "api_key": "env-••••ij",   # sentinel: same as mask_key("env-llm-key-abcdefghij")
            "max_async": 4,
            "timeout": 180,
            "temperature": 0.7,
            "max_tokens": 16384,
        },
        "embedding": {
            "binding": "openai",
            "host": "https://api.openai.com/v1",
            "model": "text-embedding-3-small",
            "api_key": "env-••••89",
            "dim": 1536,
            "token_limit": 8192,
            "send_dim": False,
            "timeout": 30,
        },
        "rerank": {
            "enabled": False,
            "binding": None,
            "host": None,
            "model": None,
            "api_key": "",
        },
    }
    if overrides:
        for path, value in overrides.items():
            section, field = path.split(".")
            body[section][field] = value
    return body


def test_post_requires_admin(app, user_token):
    client = TestClient(app)
    resp = client.post("/llm-config", json=_full_body(), headers={"Authorization": f"Bearer {user_token}"})
    assert resp.status_code == 403


def test_post_happy_llm_only_hot_swap(app, admin_token):
    client = TestClient(app)
    body = _full_body({"llm.model": "gpt-4o"})
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "applied"
    assert resp.json()["generation"] == 1
    # Overlay file written
    overlay = app.state.overlay_path
    assert overlay.exists()
    import json
    data = json.loads(overlay.read_text())
    assert data["llm"]["model"] == "gpt-4o"
    # rag mutated
    assert app.state.rag.llm_model_func == "llm:gpt-4o"
    # args mutated
    assert app.state.args.llm_model == "gpt-4o"
    # Sentinel preserved the real key
    assert data["llm"]["api_key"] == "env-llm-key-abcdefghij"


def test_post_stale_generation_returns_409(app, admin_token):
    # First bump generation so the client's `0` is stale
    import json
    app.state.overlay_path.write_text(json.dumps({"generation": 3, "llm": {}, "embedding": {}, "rerank": {}}))
    client = TestClient(app)
    body = _full_body({"llm.model": "gpt-4o"})  # generation stays 0
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "stale_config"
    assert resp.json()["detail"]["current_generation"] == 3


def test_post_embedding_rebuild_without_force_returns_409(app, admin_token):
    # Pretend there's indexed data.
    async def _has_data():
        return {"processed": 1}
    app.state.rag.doc_status.get_status_counts = _has_data  # type: ignore

    client = TestClient(app)
    body = _full_body({"embedding.model": "text-embedding-3-large", "embedding.dim": 3072})
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["error"] == "embedding_rebuild_requires_clear"
    assert detail["has_indexed_data"] is True
    assert "will_clear" in detail


def test_post_embedding_rebuild_with_force_clears_and_writes(app, admin_token, tmp_path):
    async def _has_data():
        return {"processed": 1}
    app.state.rag.doc_status.get_status_counts = _has_data  # type: ignore

    # Create a fake vdb file in the working dir so clear has something to delete.
    working = Path(app.state.rag.working_dir)
    (working / "vdb_entities.json").write_text("{}")

    client = TestClient(app)
    body = _full_body({"embedding.model": "text-embedding-3-large", "embedding.dim": 3072})
    body["force_clear"] = True
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["status"] == "restart_required"
    assert payload["reason"] == "embedding_rebuild"
    assert "vdb_entities.json" in payload["deleted"]
    assert not (working / "vdb_entities.json").exists()
    # Overlay file written after successful clear
    assert app.state.overlay_path.exists()


def test_post_sentinel_keeps_existing_key(app, admin_token):
    client = TestClient(app)
    existing = app.state.args.llm_binding_api_key
    body = _full_body({"llm.model": "gpt-4o"})
    # body["llm"]["api_key"] is already the mask of `existing`
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200
    # Real key preserved in memory and on disk
    assert app.state.args.llm_binding_api_key == existing
    import json
    data = json.loads(app.state.overlay_path.read_text())
    assert data["llm"]["api_key"] == existing


def test_post_new_key_replaces_existing(app, admin_token):
    client = TestClient(app)
    body = _full_body({"llm.model": "gpt-4o", "llm.api_key": "sk-brand-new-real-one"})
    resp = client.post("/llm-config", json=body, headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200
    assert app.state.args.llm_binding_api_key == "sk-brand-new-real-one"
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_routes.py -v
```

Expected: POST tests fail with 404 (route not defined yet).

- [ ] **Step 3: Append POST handler and pydantic models to `llm_config_routes.py`**

Append to `LightRAG/lightrag/api/routers/llm_config_routes.py`:

```python
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


# ─── POST /llm-config ───────────────────────────────────────────────────────


def _build_new_config(old: RuntimeConfig, body: LLMConfigIn) -> RuntimeConfig:
    """Merge `body` into a new RuntimeConfig using `old` for masked-key
    sentinel resolution. Keeps the incoming `generation` on the returned
    config; save_runtime_overlay bumps it."""
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
            binding=(body.rerank.binding if body.rerank.enabled else None),
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

            # Perform the destructive wipe BEFORE writing the overlay so we
            # never persist a config that doesn't match on-disk state.
            try:
                wipe = await clear_indexed_data(
                    Path(rag.working_dir) if getattr(rag, "working_dir", "") else overlay_path.parent,
                    getattr(rag, "workspace", "") or "",
                )
            except Exception as exc:  # pragma: no cover — defensive
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

            # Apply the config to args and disk so the next boot starts clean.
            # Intentionally do NOT touch rag.embedding_func — the running
            # process must restart before new embeddings are valid.
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
    """Used only on the destructive path — mutate args for all three sections
    at once, without rebuilding factories."""
    from lightrag.api.llm_config_apply import (
        _apply_embedding_to_args,
        _apply_llm_to_args,
        _apply_rerank_to_args,
    )
    _apply_llm_to_args(args, new.llm)
    _apply_embedding_to_args(args, new.embedding)
    _apply_rerank_to_args(args, new.rerank)
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests/api/test_llm_config_routes.py -v
```

Expected: all POST and GET tests PASS. Fix any minor issues (pydantic v1 vs v2 syntax, response_model field names) inline and re-run until green.

- [ ] **Step 5: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/routers/llm_config_routes.py LightRAG/tests/api/test_llm_config_routes.py
git commit -m "feat(llm-config): add POST /llm-config with hot-swap and destructive paths"
```

---

## Task 8: Wire everything into `lightrag_server.py`

**Files:**
- Modify: `LightRAG/lightrag/api/lightrag_server.py`

Spec reference: §5.4.

This task does three things: (1) extract the inline rerank block into a top-level-scoped helper so it can be re-invoked, (2) load the runtime overlay right after argparse, (3) stash state and mount the router after `rag` is constructed.

- [ ] **Step 1: Add imports**

Near the top of `lightrag_server.py` (grouped with existing `lightrag.api.*` imports):

```python
from lightrag.api.runtime_config import load_runtime_overlay
from lightrag.api.llm_config_apply import FactoryBundle
from lightrag.api.routers.llm_config_routes import router as llm_config_router
```

- [ ] **Step 2: Load overlay right after `parse_args`**

Find `get_application(args)` in `lightrag_server.py`. Directly after the block that populates `args` from `global_args` / env (inside `get_application`, before `config_cache` is built), insert:

```python
# Runtime config overlay — merges docs/specs/…-lightrag-llm-provider-settings-design.md
# (runtime_config.json) into `args` before the LLM/embedding factories run.
# Silent no-op if the file doesn't exist.
overlay_path = Path(args.working_dir) / "runtime_config.json"
load_runtime_overlay(args, overlay_path)
```

- [ ] **Step 3: Extract rerank into a local helper**

Currently (lines ~984–1049) the rerank setup builds `server_rerank_func` inline and assigns it to `rerank_model_func`. Wrap that block in a helper so the factory bundle can re-invoke it:

Replace the block starting at `rerank_model_func = None` and ending at `logger.info("Reranking is disabled")` with:

```python
    def create_rerank_func(args):
        """Build the rerank callable from the current `args`. Returns None if
        `rerank_binding == "null"`. Keeps the original logic intact; just lifts
        it into a function so llm_config_apply.apply_hot can re-invoke it."""
        if args.rerank_binding == "null":
            logger.info("Reranking is disabled")
            return None

        from lightrag.rerank import cohere_rerank, jina_rerank, ali_rerank

        rerank_functions = {
            "cohere": cohere_rerank,
            "jina": jina_rerank,
            "aliyun": ali_rerank,
        }

        selected_rerank_func = rerank_functions.get(args.rerank_binding)
        if not selected_rerank_func:
            logger.error(f"Unsupported rerank binding: {args.rerank_binding}")
            raise ValueError(f"Unsupported rerank binding: {args.rerank_binding}")

        if args.rerank_model is None or args.rerank_binding_host is None:
            sig = inspect.signature(selected_rerank_func)
            if args.rerank_model is None and "model" in sig.parameters:
                default_model = sig.parameters["model"].default
                if default_model != inspect.Parameter.empty:
                    args.rerank_model = default_model
            if args.rerank_binding_host is None and "base_url" in sig.parameters:
                default_base_url = sig.parameters["base_url"].default
                if default_base_url != inspect.Parameter.empty:
                    args.rerank_binding_host = default_base_url

        async def server_rerank_func(
            query: str, documents: list, top_n: int = None, extra_body: dict = None
        ):
            kwargs = {
                "query": query,
                "documents": documents,
                "top_n": top_n,
                "api_key": args.rerank_binding_api_key,
                "model": args.rerank_model,
                "base_url": args.rerank_binding_host,
            }
            if args.rerank_binding == "cohere":
                kwargs["enable_chunking"] = (
                    os.getenv("RERANK_ENABLE_CHUNKING", "false").lower() == "true"
                )
                kwargs["max_tokens_per_doc"] = int(
                    os.getenv("RERANK_MAX_TOKENS_PER_DOC", "4096")
                )
            return await selected_rerank_func(**kwargs, extra_body=extra_body)

        logger.info(
            f"Reranking is enabled: {args.rerank_model or 'default model'} "
            f"using {args.rerank_binding} provider"
        )
        return server_rerank_func

    rerank_model_func = create_rerank_func(args)
```

`inspect` is already imported inside `get_application` via `import inspect` (see line ~926 of the current file). Leave that import alone.

- [ ] **Step 4: Stash state and include router after `rag` is created**

Find the block right after `rag = LightRAG(...)` is constructed (around lines ~1060–1090) and before the router-wiring section. Add:

```python
    # Expose state for the runtime LLM config routes.
    app.state.rag = rag
    app.state.args = args
    app.state.overlay_path = overlay_path
    app.state.llm_config_lock = asyncio.Lock()
    app.state.factories = FactoryBundle(
        make_llm_func=lambda: create_llm_model_func(args.llm_binding),
        make_llm_kwargs=lambda: create_llm_model_kwargs(args.llm_binding, args, llm_timeout),
        make_embedding_func=lambda: create_optimized_embedding_function(
            config_cache=config_cache,
            binding=args.embedding_binding,
            model=args.embedding_model,
            host=args.embedding_binding_host,
            api_key=args.embedding_binding_api_key,
            args=args,
        ),
        make_rerank_func=lambda: create_rerank_func(args),
    )
    app.include_router(llm_config_router)
```

Add `import asyncio` at the top of the file if it isn't already imported.

- [ ] **Step 5: Smoke-import test — run existing offline tests**

```bash
cd /Users/lance/LaboFlow/LightRAG
python -m pytest tests -q -k "llm_config or sso_role or runtime_config"
```

Expected: all tests added so far PASS, and the existing test suite is unaffected.

Also verify the server still imports cleanly:

```bash
cd /Users/lance/LaboFlow/LightRAG
python -c "from lightrag.api.lightrag_server import get_application; print('ok')"
```

Expected: `ok`. Any import error indicates a typo in the edits above.

- [ ] **Step 6: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag/api/lightrag_server.py
git commit -m "feat(llm-config): wire runtime overlay, factory bundle, router into server"
```

---

## Task 9: Surface `role` on `useAuthStore`

**Files:**
- Modify: `LightRAG/lightrag_webui/src/stores/state.ts`

Spec reference: §5.7.

- [ ] **Step 1: Read the current `AuthState` interface and initAuthState helper**

Read `LightRAG/lightrag_webui/src/stores/state.ts` to confirm line numbers — you'll edit the `AuthState` type, the `parseTokenPayload` / `initAuthState` helpers, and the `useAuthStore` factory to surface `role`.

- [ ] **Step 2: Add `role` to the `AuthState` interface**

In `state.ts`, extend the `AuthState` interface (near line 28):

Old:

```typescript
interface AuthState {
  isAuthenticated: boolean;
  isGuestMode: boolean;  // Add guest mode flag
  coreVersion: string | null;
  apiVersion: string | null;
  username: string | null; // login username
```

New:

```typescript
interface AuthState {
  isAuthenticated: boolean;
  isGuestMode: boolean;  // Add guest mode flag
  coreVersion: string | null;
  apiVersion: string | null;
  username: string | null; // login username
  role: string | null; // JWT role claim (e.g. "platform_admin", "user", "guest")
```

- [ ] **Step 3: Add a `getRoleFromToken` helper**

Below `getUsernameFromToken` (~line 190):

```typescript
const getRoleFromToken = (token: string): string | null => {
  const payload = parseTokenPayload(token);
  return payload.role || null;
};
```

- [ ] **Step 4: Populate `role` in `initAuthState`**

Find `initAuthState` (~line 202). In the unauthenticated branch, add `role: null,`. In the authenticated branch, add:

```typescript
    role: getRoleFromToken(token),
```

Also extend the return type of `initAuthState` to include `role: string | null;`.

- [ ] **Step 5: Initialize and maintain `role` in the store**

In the `useAuthStore` factory, add `role: initialState.role,` to the initial state. In the `login` action, add `role: getRoleFromToken(token),` alongside `username`. In the `logout` action, add `role: null,`.

- [ ] **Step 6: Lint check**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun run lint
```

Expected: no new errors. Fix type errors inline.

- [ ] **Step 7: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/stores/state.ts
git commit -m "feat(webui): surface JWT role on useAuthStore"
```

---

## Task 10: Add API client and provider preset catalog

**Files:**
- Create: `LightRAG/lightrag_webui/src/api/llmConfig.ts`
- Create: `LightRAG/lightrag_webui/src/lib/llmProviderPresets.ts`
- Test: `LightRAG/lightrag_webui/src/api/llmConfig.test.ts`

Spec reference: §4.2, §5.6.

- [ ] **Step 1: Write the failing client tests**

Create `LightRAG/lightrag_webui/src/api/llmConfig.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test'
import { maskedKeySentinel, buildPostBody, type LLMConfigOut } from './llmConfig'

const SAMPLE_GET: LLMConfigOut = {
  generation: 3,
  llm: {
    binding: 'openai',
    host: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    api_key_masked: 'env-••••ij',
    max_async: 4,
    timeout: 180,
    temperature: 0.7,
    max_tokens: 16384,
    source: 'env',
  },
  embedding: {
    binding: 'openai',
    host: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    api_key_masked: 'env-••••89',
    dim: 1536,
    token_limit: 8192,
    send_dim: false,
    timeout: 30,
    source: 'env',
  },
  rerank: {
    enabled: false,
    binding: null,
    host: null,
    model: null,
    api_key_masked: '',
    source: 'env',
  },
  providers: {
    llm_bindings: ['openai'],
    openai_compatible_presets: [],
    embedding_bindings: ['openai'],
    rerank_bindings: ['jina'],
  },
  has_indexed_data: false,
}

describe('maskedKeySentinel', () => {
  it('returns the mask as-is when user has not edited', () => {
    expect(maskedKeySentinel('env-••••ij', 'env-••••ij')).toBe('env-••••ij')
  })

  it('returns the edited value when user typed a new key', () => {
    expect(maskedKeySentinel('sk-newkey123', 'env-••••ij')).toBe('sk-newkey123')
  })
})

describe('buildPostBody', () => {
  it('round-trips GET response as an unchanged POST body', () => {
    const body = buildPostBody(SAMPLE_GET, SAMPLE_GET)
    expect(body.generation).toBe(3)
    expect(body.force_clear).toBe(false)
    expect(body.llm.api_key).toBe('env-••••ij')   // sentinel unchanged
    expect(body.embedding.api_key).toBe('env-••••89')
  })

  it('propagates user edits to llm.model', () => {
    const edited = structuredClone(SAMPLE_GET)
    edited.llm.model = 'gpt-4o'
    const body = buildPostBody(edited, SAMPLE_GET)
    expect(body.llm.model).toBe('gpt-4o')
  })

  it('sets rerank enabled flag from the edit state', () => {
    const edited = structuredClone(SAMPLE_GET)
    edited.rerank.enabled = true
    edited.rerank.binding = 'jina'
    edited.rerank.model = 'jina-reranker-v2-base-multilingual'
    const body = buildPostBody(edited, SAMPLE_GET)
    expect(body.rerank.enabled).toBe(true)
    expect(body.rerank.binding).toBe('jina')
  })
})
```

- [ ] **Step 2: Run the test — expect failure**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun test src/api/llmConfig.test.ts
```

Expected: `Module not found: 'llmConfig'`.

- [ ] **Step 3: Create `llmConfig.ts`**

Create `LightRAG/lightrag_webui/src/api/llmConfig.ts`:

```typescript
/**
 * Typed client for /kb-api/llm-config.
 *
 * Piggybacks on the existing `axiosInstance` in lightrag.ts — we don't
 * re-export it to keep the scope of that file focused, and building a second
 * instance here is cheap.
 */
import axios from 'axios'
import { backendBaseUrl } from '@/lib/constants'

export interface LLMSection {
  binding: string | null
  host: string | null
  model: string | null
  api_key_masked: string
  max_async?: number | null
  timeout?: number | null
  temperature?: number | null
  max_tokens?: number | null
  source: 'overlay' | 'env'
}

export interface EmbeddingSection {
  binding: string | null
  host: string | null
  model: string | null
  api_key_masked: string
  dim?: number | null
  token_limit?: number | null
  send_dim?: boolean | null
  timeout?: number | null
  source: 'overlay' | 'env'
}

export interface RerankSection {
  enabled: boolean
  binding: string | null
  host: string | null
  model: string | null
  api_key_masked: string
  source: 'overlay' | 'env'
}

export interface ProviderCatalog {
  llm_bindings: string[]
  openai_compatible_presets: Array<{
    id: string
    display_name: string
    base_url: string
    default_max_tokens: number
  }>
  embedding_bindings: string[]
  rerank_bindings: string[]
}

export interface LLMConfigOut {
  generation: number
  llm: LLMSection
  embedding: EmbeddingSection
  rerank: RerankSection
  providers: ProviderCatalog
  has_indexed_data: boolean
}

export interface LLMSectionIn {
  binding: string | null
  host: string | null
  model: string | null
  api_key: string
  max_async?: number | null
  timeout?: number | null
  temperature?: number | null
  max_tokens?: number | null
}

export interface EmbeddingSectionIn {
  binding: string | null
  host: string | null
  model: string | null
  api_key: string
  dim?: number | null
  token_limit?: number | null
  send_dim?: boolean | null
  timeout?: number | null
}

export interface RerankSectionIn {
  enabled: boolean
  binding: string | null
  host: string | null
  model: string | null
  api_key: string
}

export interface LLMConfigIn {
  generation: number
  force_clear: boolean
  llm: LLMSectionIn
  embedding: EmbeddingSectionIn
  rerank: RerankSectionIn
}

export type PostResult =
  | { status: 'applied'; generation: number }
  | { status: 'restart_required'; reason: string; generation: number; deleted: string[] }

export interface DestructiveConfirmDetail {
  error: 'embedding_rebuild_requires_clear'
  has_indexed_data: boolean
  will_clear: string[]
}

export interface StaleConfigDetail {
  error: 'stale_config'
  current_generation: number
}

/** Axios instance dedicated to /llm-config. */
const client = axios.create({
  baseURL: backendBaseUrl,
  headers: { 'Content-Type': 'application/json' },
})

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('LIGHTRAG-API-TOKEN')
  if (token) {
    config.headers = config.headers ?? {}
    ;(config.headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
  }
  return config
})

export async function fetchLLMConfig(): Promise<LLMConfigOut> {
  const resp = await client.get<LLMConfigOut>('/llm-config')
  return resp.data
}

export async function postLLMConfig(body: LLMConfigIn): Promise<PostResult> {
  const resp = await client.post<PostResult>('/llm-config', body)
  return resp.data
}

/**
 * Sentinel helper: if the user never touched the api_key field, the edited
 * form still holds the masked string from GET. Round-tripping that string
 * is the signal to the server that it should keep the existing real key.
 */
export function maskedKeySentinel(edited: string, original: string): string {
  return edited === original ? original : edited
}

/** Build a POST body from the edited form state, preserving masked-key sentinels. */
export function buildPostBody(edited: LLMConfigOut, original: LLMConfigOut): LLMConfigIn {
  return {
    generation: original.generation,
    force_clear: false,
    llm: {
      binding: edited.llm.binding,
      host: edited.llm.host,
      model: edited.llm.model,
      api_key: maskedKeySentinel(edited.llm.api_key_masked, original.llm.api_key_masked),
      max_async: edited.llm.max_async ?? null,
      timeout: edited.llm.timeout ?? null,
      temperature: edited.llm.temperature ?? null,
      max_tokens: edited.llm.max_tokens ?? null,
    },
    embedding: {
      binding: edited.embedding.binding,
      host: edited.embedding.host,
      model: edited.embedding.model,
      api_key: maskedKeySentinel(edited.embedding.api_key_masked, original.embedding.api_key_masked),
      dim: edited.embedding.dim ?? null,
      token_limit: edited.embedding.token_limit ?? null,
      send_dim: edited.embedding.send_dim ?? null,
      timeout: edited.embedding.timeout ?? null,
    },
    rerank: {
      enabled: edited.rerank.enabled,
      binding: edited.rerank.binding,
      host: edited.rerank.host,
      model: edited.rerank.model,
      api_key: maskedKeySentinel(edited.rerank.api_key_masked, original.rerank.api_key_masked),
    },
  }
}
```

- [ ] **Step 4: Run the test — expect pass**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun test src/api/llmConfig.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Create `llmProviderPresets.ts`**

Create `LightRAG/lightrag_webui/src/lib/llmProviderPresets.ts`:

```typescript
/**
 * Static catalog used when the server response is stale / unavailable.
 * The server copy in lightrag/api/routers/llm_config_routes.py::PROVIDERS
 * is the source of truth — keep both in sync.
 */

export interface OpenAICompatiblePreset {
  id: string
  display_name: string
  base_url: string
  default_max_tokens: number
}

export const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [
  { id: 'openai',     display_name: 'OpenAI',            base_url: 'https://api.openai.com/v1',                               default_max_tokens: 16384 },
  { id: 'deepseek',   display_name: 'DeepSeek',          base_url: 'https://api.deepseek.com/v1',                             default_max_tokens: 8192 },
  { id: 'kimi',       display_name: 'Kimi',              base_url: 'https://api.moonshot.cn/v1',                              default_max_tokens: 8192 },
  { id: 'qwen',       display_name: 'Qwen (DashScope)',  base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',       default_max_tokens: 8192 },
  { id: 'zhipu',      display_name: 'Zhipu',             base_url: 'https://open.bigmodel.cn/api/paas/v4',                    default_max_tokens: 8192 },
  { id: 'openrouter', display_name: 'OpenRouter',        base_url: 'https://openrouter.ai/api/v1',                            default_max_tokens: 4096 },
  { id: 'vllm',       display_name: 'vLLM',              base_url: 'http://localhost:8000/v1',                                default_max_tokens: 4096 },
  { id: 'sglang',     display_name: 'SGLang',            base_url: 'http://localhost:30000/v1',                               default_max_tokens: 4096 },
  { id: 'custom',     display_name: 'Custom',            base_url: '',                                                         default_max_tokens: 4096 },
]

export const LLM_BINDINGS = ['openai', 'ollama', 'azure_openai', 'gemini', 'aws_bedrock', 'lollms'] as const
export const EMBEDDING_BINDINGS = ['openai', 'ollama', 'gemini', 'jina', 'azure_openai', 'aws_bedrock', 'lollms'] as const
export const RERANK_BINDINGS = ['cohere', 'jina', 'aliyun'] as const
```

- [ ] **Step 6: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/api/llmConfig.ts LightRAG/lightrag_webui/src/api/llmConfig.test.ts LightRAG/lightrag_webui/src/lib/llmProviderPresets.ts
git commit -m "feat(webui): add llmConfig API client and provider preset catalog"
```

---

## Task 11: `LLMSection.tsx` — LLM provider form

**Files:**
- Create: `LightRAG/lightrag_webui/src/features/LLMConfigDialog/LLMSection.tsx`

Spec reference: §5.5.

Because this component is purely presentational and its test requires full DOM setup (React Testing Library is not currently configured in this WebUI), we skip a dedicated test file and rely on the manual smoke test in Task 16 plus the `bun run lint` / `tsc` pass. If you later add React Testing Library support, retrofit a `LLMSection.test.tsx` following the manual-smoke bullets.

- [ ] **Step 1: Create the file**

Create `LightRAG/lightrag_webui/src/features/LLMConfigDialog/LLMSection.tsx`:

```typescript
import { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select'
import Input from '@/components/ui/Input'
import { OPENAI_COMPATIBLE_PRESETS } from '@/lib/llmProviderPresets'
import type { LLMConfigOut, LLMSection as LLMSectionType, ProviderCatalog } from '@/api/llmConfig'

interface Props {
  value: LLMSectionType
  original: LLMSectionType
  catalog: ProviderCatalog
  onChange: (next: LLMSectionType) => void
}

export default function LLMSection({ value, original, catalog, onChange }: Props) {
  const { t } = useTranslation()

  const update = (patch: Partial<LLMSectionType>) => onChange({ ...value, ...patch })

  const handlePresetChange = (presetId: string) => {
    const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    update({
      host: preset.base_url,
      max_tokens: preset.default_max_tokens,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.llm.binding')}</label>
        <Select value={value.binding ?? ''} onValueChange={(v) => update({ binding: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {catalog.llm_bindings.map((b) => (
              <SelectItem key={b} value={b}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {t('llmConfig.sourceLabel')}: {value.source === 'overlay' ? t('llmConfig.source.overlay') : t('llmConfig.source.env')}
        </span>
      </div>

      {value.binding === 'openai' && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.llm.preset')}</label>
          <Select onValueChange={handlePresetChange}>
            <SelectTrigger>
              <SelectValue placeholder={t('llmConfig.llm.presetPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {catalog.openai_compatible_presets.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.display_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.llm.host')}</label>
        <Input
          value={value.host ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ host: e.target.value })}
          placeholder="https://api.openai.com/v1"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.llm.model')}</label>
        <Input
          value={value.model ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ model: e.target.value })}
          placeholder="gpt-4o-mini"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.llm.apiKey')}</label>
        <Input
          type="password"
          value={value.api_key_masked}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ api_key_masked: e.target.value })}
          placeholder={original.api_key_masked || 'sk-…'}
        />
        <span className="text-xs text-muted-foreground">{t('llmConfig.apiKeyHint')}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.llm.maxAsync')}</label>
          <Input
            type="number"
            value={value.max_async ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ max_async: Number(e.target.value) || null })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.llm.timeout')}</label>
          <Input
            type="number"
            value={value.timeout ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ timeout: Number(e.target.value) || null })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.llm.temperature')}</label>
          <Input
            type="number"
            step="0.1"
            value={value.temperature ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ temperature: Number(e.target.value) || null })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.llm.maxTokens')}</label>
          <Input
            type="number"
            value={value.max_tokens ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ max_tokens: Number(e.target.value) || null })}
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify imports resolve**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun run lint
```

Expected: no new errors. If `@/components/ui/Input` has a different export shape, adjust the import — read the file first:

```bash
# sanity check
ls src/components/ui/Input.tsx
```

- [ ] **Step 3: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/features/LLMConfigDialog/LLMSection.tsx
git commit -m "feat(webui): add LLMSection form component"
```

---

## Task 12: `EmbeddingSection.tsx` and `DestructiveConfirm.tsx`

**Files:**
- Create: `LightRAG/lightrag_webui/src/features/LLMConfigDialog/EmbeddingSection.tsx`
- Create: `LightRAG/lightrag_webui/src/features/LLMConfigDialog/DestructiveConfirm.tsx`

Spec reference: §5.5.

- [ ] **Step 1: Create `EmbeddingSection.tsx`**

Create `LightRAG/lightrag_webui/src/features/LLMConfigDialog/EmbeddingSection.tsx`:

```typescript
import { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select'
import Input from '@/components/ui/Input'
import type { EmbeddingSection as EmbeddingSectionType, ProviderCatalog } from '@/api/llmConfig'

interface Props {
  value: EmbeddingSectionType
  original: EmbeddingSectionType
  catalog: ProviderCatalog
  hasIndexedData: boolean
  onChange: (next: EmbeddingSectionType) => void
}

/**
 * Embedding form. When `hasIndexedData` is true, the binding/model/dim inputs
 * are visually marked as destructive — the user can still edit them, but the
 * dialog will surface a confirm step before POSTing.
 */
export default function EmbeddingSection({ value, original, catalog, hasIndexedData, onChange }: Props) {
  const { t } = useTranslation()
  const update = (patch: Partial<EmbeddingSectionType>) => onChange({ ...value, ...patch })

  return (
    <div className="flex flex-col gap-4">
      {hasIndexedData && (
        <div className="rounded border border-amber-500 bg-amber-50 dark:bg-amber-950 p-3 text-sm">
          {t('llmConfig.embedding.hasDataWarning')}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.embedding.binding')}</label>
        <Select value={value.binding ?? ''} onValueChange={(v) => update({ binding: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {catalog.embedding_bindings.map((b) => (
              <SelectItem key={b} value={b}>{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {t('llmConfig.sourceLabel')}: {value.source === 'overlay' ? t('llmConfig.source.overlay') : t('llmConfig.source.env')}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.embedding.host')}</label>
        <Input
          value={value.host ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ host: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.embedding.model')}</label>
        <Input
          value={value.model ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ model: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">{t('llmConfig.embedding.apiKey')}</label>
        <Input
          type="password"
          value={value.api_key_masked}
          onChange={(e: ChangeEvent<HTMLInputElement>) => update({ api_key_masked: e.target.value })}
          placeholder={original.api_key_masked || 'sk-…'}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.embedding.dim')}</label>
          <Input
            type="number"
            value={value.dim ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ dim: Number(e.target.value) || null })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.embedding.tokenLimit')}</label>
          <Input
            type="number"
            value={value.token_limit ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ token_limit: Number(e.target.value) || null })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.embedding.sendDim')}</label>
          <Select
            value={value.send_dim ? 'true' : 'false'}
            onValueChange={(v) => update({ send_dim: v === 'true' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">true</SelectItem>
              <SelectItem value="false">false</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">{t('llmConfig.embedding.timeout')}</label>
          <Input
            type="number"
            value={value.timeout ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => update({ timeout: Number(e.target.value) || null })}
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `DestructiveConfirm.tsx`**

Create `LightRAG/lightrag_webui/src/features/LLMConfigDialog/DestructiveConfirm.tsx`:

```typescript
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Input from '@/components/ui/Input'
import Button from '@/components/ui/Button'

interface Props {
  willClear: string[]
  onCancel: () => void
  onConfirm: () => void
}

export default function DestructiveConfirm({ willClear, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const canConfirm = typed === 'CLEAR'

  return (
    <div className="flex flex-col gap-4 rounded border border-red-500 p-4">
      <h3 className="text-base font-semibold text-red-600">
        {t('llmConfig.destructive.title')}
      </h3>
      <p className="text-sm">{t('llmConfig.destructive.body')}</p>
      <ul className="list-disc pl-5 text-xs text-muted-foreground">
        {willClear.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <label className="text-sm">{t('llmConfig.destructive.typePrompt')}</label>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="CLEAR" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('llmConfig.destructive.cancel')}
        </Button>
        <Button disabled={!canConfirm} onClick={onConfirm}>
          {t('llmConfig.destructive.confirm')}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Lint**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun run lint
```

Expected: clean. Fix inline issues (import path casing, Button variant names) until clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/features/LLMConfigDialog/EmbeddingSection.tsx LightRAG/lightrag_webui/src/features/LLMConfigDialog/DestructiveConfirm.tsx
git commit -m "feat(webui): add EmbeddingSection and DestructiveConfirm components"
```

---

## Task 13: `RerankSection.tsx`

**Files:**
- Create: `LightRAG/lightrag_webui/src/features/LLMConfigDialog/RerankSection.tsx`

Spec reference: §5.5.

- [ ] **Step 1: Create the file**

Create `LightRAG/lightrag_webui/src/features/LLMConfigDialog/RerankSection.tsx`:

```typescript
import { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select'
import Input from '@/components/ui/Input'
import Switch from '@/components/ui/Switch'
import type { RerankSection as RerankSectionType, ProviderCatalog } from '@/api/llmConfig'

interface Props {
  value: RerankSectionType
  original: RerankSectionType
  catalog: ProviderCatalog
  onChange: (next: RerankSectionType) => void
}

export default function RerankSection({ value, original, catalog, onChange }: Props) {
  const { t } = useTranslation()
  const update = (patch: Partial<RerankSectionType>) => onChange({ ...value, ...patch })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{t('llmConfig.rerank.enabled')}</label>
        <Switch
          checked={value.enabled}
          onCheckedChange={(checked: boolean) => update({ enabled: checked })}
        />
      </div>

      {value.enabled && (
        <>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t('llmConfig.rerank.binding')}</label>
            <Select value={value.binding ?? ''} onValueChange={(v) => update({ binding: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catalog.rerank_bindings.map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t('llmConfig.rerank.host')}</label>
            <Input
              value={value.host ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update({ host: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t('llmConfig.rerank.model')}</label>
            <Input
              value={value.model ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update({ model: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t('llmConfig.rerank.apiKey')}</label>
            <Input
              type="password"
              value={value.api_key_masked}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update({ api_key_masked: e.target.value })}
              placeholder={original.api_key_masked}
            />
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify `Switch` component exists**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
ls src/components/ui/Switch.tsx
```

If it doesn't exist, replace the `<Switch>` element with a checkbox `<input type="checkbox" checked={value.enabled} onChange={(e) => update({ enabled: e.target.checked })} />` or reuse an existing toggle from elsewhere in the codebase (grep for `SwitchPrimitive` or `role="switch"`).

- [ ] **Step 3: Lint**

```bash
bun run lint
```

- [ ] **Step 4: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/features/LLMConfigDialog/RerankSection.tsx
git commit -m "feat(webui): add RerankSection form component"
```

---

## Task 14: `LLMConfigDialog/index.tsx` — wrapper and flow

**Files:**
- Create: `LightRAG/lightrag_webui/src/features/LLMConfigDialog/index.tsx`

Spec reference: §5.5.

- [ ] **Step 1: Create the file**

Create `LightRAG/lightrag_webui/src/features/LLMConfigDialog/index.tsx`:

```typescript
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AxiosError } from 'axios'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import Button from '@/components/ui/Button'
import LLMSection from './LLMSection'
import EmbeddingSection from './EmbeddingSection'
import RerankSection from './RerankSection'
import DestructiveConfirm from './DestructiveConfirm'
import {
  buildPostBody,
  fetchLLMConfig,
  postLLMConfig,
  type LLMConfigIn,
  type LLMConfigOut,
  type PostResult,
} from '@/api/llmConfig'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type DialogState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; original: LLMConfigOut; edited: LLMConfigOut }
  | { kind: 'destructive'; willClear: string[]; pending: LLMConfigIn }
  | { kind: 'restartRequired'; deleted: string[] }

export default function LLMConfigDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const [state, setState] = useState<DialogState>({ kind: 'loading' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const data = await fetchLLMConfig()
      setState({ kind: 'ready', original: data, edited: structuredClone(data) })
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message || 'load failed' })
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const save = useCallback(
    async (body: LLMConfigIn) => {
      setSaving(true)
      try {
        const result: PostResult = await postLLMConfig(body)
        if (result.status === 'applied') {
          toast.success(t('llmConfig.toastApplied'))
          onOpenChange(false)
        } else {
          setState({ kind: 'restartRequired', deleted: result.deleted })
          toast.warning(t('llmConfig.toastRestartRequired'))
        }
      } catch (e) {
        const err = e as AxiosError<{ detail?: any }>
        const status = err.response?.status
        const detail = err.response?.data?.detail
        if (status === 409 && detail?.error === 'embedding_rebuild_requires_clear') {
          setState({ kind: 'destructive', willClear: detail.will_clear, pending: body })
          return
        }
        if (status === 409 && detail?.error === 'stale_config') {
          toast.error(t('llmConfig.toastStale'))
          await load()
          return
        }
        if (status === 403) {
          toast.error(t('llmConfig.toastForbidden'))
          return
        }
        toast.error((err.message || 'save failed') as string)
      } finally {
        setSaving(false)
      }
    },
    [onOpenChange, load, t]
  )

  const handleSave = () => {
    if (state.kind !== 'ready') return
    const body = buildPostBody(state.edited, state.original)
    save(body)
  }

  const handleDestructiveConfirm = () => {
    if (state.kind !== 'destructive') return
    save({ ...state.pending, force_clear: true })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('llmConfig.title')}</DialogTitle>
          <DialogDescription>{t('llmConfig.description')}</DialogDescription>
        </DialogHeader>

        {state.kind === 'loading' && <p>{t('llmConfig.loading')}</p>}
        {state.kind === 'error' && <p className="text-red-600">{state.message}</p>}

        {state.kind === 'destructive' && (
          <DestructiveConfirm
            willClear={state.willClear}
            onCancel={() => load()}
            onConfirm={handleDestructiveConfirm}
          />
        )}

        {state.kind === 'restartRequired' && (
          <div className="rounded border border-amber-500 bg-amber-50 dark:bg-amber-950 p-4 text-sm">
            <p className="font-medium mb-2">{t('llmConfig.restartRequired.title')}</p>
            <p className="mb-2">{t('llmConfig.restartRequired.body')}</p>
            <ul className="list-disc pl-5 text-xs">
              {state.deleted.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

        {state.kind === 'ready' && (
          <Tabs defaultValue="llm">
            <TabsList>
              <TabsTrigger value="llm">{t('llmConfig.tabs.llm')}</TabsTrigger>
              <TabsTrigger value="embedding">{t('llmConfig.tabs.embedding')}</TabsTrigger>
              <TabsTrigger value="rerank">{t('llmConfig.tabs.rerank')}</TabsTrigger>
            </TabsList>
            <TabsContent value="llm">
              <LLMSection
                value={state.edited.llm}
                original={state.original.llm}
                catalog={state.edited.providers}
                onChange={(llm) => setState({ ...state, edited: { ...state.edited, llm } })}
              />
            </TabsContent>
            <TabsContent value="embedding">
              <EmbeddingSection
                value={state.edited.embedding}
                original={state.original.embedding}
                catalog={state.edited.providers}
                hasIndexedData={state.edited.has_indexed_data}
                onChange={(embedding) => setState({ ...state, edited: { ...state.edited, embedding } })}
              />
            </TabsContent>
            <TabsContent value="rerank">
              <RerankSection
                value={state.edited.rerank}
                original={state.original.rerank}
                catalog={state.edited.providers}
                onChange={(rerank) => setState({ ...state, edited: { ...state.edited, rerank } })}
              />
            </TabsContent>
          </Tabs>
        )}

        {state.kind === 'ready' && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('llmConfig.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t('llmConfig.saving') : t('llmConfig.save')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Sanity check `sonner` / `toast` availability**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
grep -r "from 'sonner'" src | head -5
```

If `sonner` is already used in the codebase, this import will work. If not, replace `toast.success(...)` / `toast.error(...)` with `alert(...)` or a `console.info(...)` fallback — the toast UX is nice-to-have and not critical. Do NOT add new dependencies as part of this plan.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/features/LLMConfigDialog/index.tsx
git commit -m "feat(webui): add LLMConfigDialog wrapper with 3-tab layout"
```

---

## Task 15: `LLMConfigButton.tsx`, SiteHeader wire-up, and i18n

**Files:**
- Create: `LightRAG/lightrag_webui/src/features/LLMConfigButton.tsx`
- Modify: `LightRAG/lightrag_webui/src/features/SiteHeader.tsx`
- Modify: `LightRAG/lightrag_webui/src/locales/en.json`
- Modify: `LightRAG/lightrag_webui/src/locales/zh.json`

Spec reference: §5.7, §9.2.

- [ ] **Step 1: Create `LLMConfigButton.tsx`**

Create `LightRAG/lightrag_webui/src/features/LLMConfigButton.tsx`:

```typescript
import { useState } from 'react'
import { SettingsIcon } from 'lucide-react'
import Button from '@/components/ui/Button'
import { useAuthStore } from '@/stores/state'
import { useTranslation } from 'react-i18next'
import LLMConfigDialog from './LLMConfigDialog'

export default function LLMConfigButton() {
  const { t } = useTranslation()
  const role = useAuthStore((s) => s.role)
  const [open, setOpen] = useState(false)

  // Admin-only gear. Non-admins never see this button.
  if (role !== 'platform_admin') return null

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        side="bottom"
        tooltip={t('header.llmConfig')}
        onClick={() => setOpen(true)}
      >
        <SettingsIcon className="size-4" aria-hidden="true" />
      </Button>
      <LLMConfigDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
```

- [ ] **Step 2: Mount it in `SiteHeader.tsx`**

Open `LightRAG/lightrag_webui/src/features/SiteHeader.tsx` and edit around line 133:

Old:

```typescript
          <AppSettings />
          {!isGuestMode && (
```

New:

```typescript
          <AppSettings />
          <LLMConfigButton />
          {!isGuestMode && (
```

Also add the import at the top:

```typescript
import LLMConfigButton from '@/features/LLMConfigButton'
```

- [ ] **Step 3: Add i18n keys to `en.json`**

Open `LightRAG/lightrag_webui/src/locales/en.json`. Find `"header": { ... }` (line 9) and add `"llmConfig": "LLM provider settings"` inside that object.

Then add a new top-level `"llmConfig"` block after the existing section that's alphabetically closest (or at the end before the final `}`):

```json
  "llmConfig": {
    "title": "LLM provider settings",
    "description": "Configure LLM, embedding, and rerank providers. Changes take effect immediately where safe.",
    "loading": "Loading current config…",
    "saving": "Saving…",
    "save": "Save",
    "cancel": "Cancel",
    "sourceLabel": "Source",
    "apiKeyHint": "Leave unchanged to keep the existing key.",
    "toastApplied": "Configuration applied.",
    "toastRestartRequired": "Indexed data cleared — restart LightRAG to finish.",
    "toastStale": "Config changed elsewhere — reloaded the latest version.",
    "toastForbidden": "Admin privileges required.",
    "source": { "overlay": "runtime", "env": "env file" },
    "tabs": { "llm": "LLM", "embedding": "Embedding", "rerank": "Rerank" },
    "llm": {
      "binding": "Binding",
      "preset": "OpenAI-compatible preset",
      "presetPlaceholder": "Pick a preset to auto-fill host",
      "host": "Host",
      "model": "Model",
      "apiKey": "API Key",
      "maxAsync": "Max async",
      "timeout": "Timeout (s)",
      "temperature": "Temperature",
      "maxTokens": "Max tokens"
    },
    "embedding": {
      "binding": "Binding",
      "host": "Host",
      "model": "Model",
      "apiKey": "API Key",
      "dim": "Dimension",
      "tokenLimit": "Token limit",
      "sendDim": "Send dimension",
      "timeout": "Timeout (s)",
      "hasDataWarning": "Warning: indexed data exists. Changing binding/model/dimension will require clearing all indexed data."
    },
    "rerank": {
      "enabled": "Enabled",
      "binding": "Binding",
      "host": "Host",
      "model": "Model",
      "apiKey": "API Key"
    },
    "destructive": {
      "title": "Destructive change",
      "body": "The selected embedding change requires clearing all indexed data. This cannot be undone.",
      "typePrompt": "Type CLEAR to confirm",
      "cancel": "Cancel",
      "confirm": "Clear and apply"
    },
    "restartRequired": {
      "title": "Restart required",
      "body": "Indexed data has been cleared. Restart the LightRAG server to activate the new embedding model."
    }
  }
```

Ensure the JSON remains valid (no trailing comma at the end of the file). Validate with `bun -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8'))"` — any error means a misplaced comma.

- [ ] **Step 4: Add matching zh.json keys**

Open `LightRAG/lightrag_webui/src/locales/zh.json`. Add `"llmConfig": "LLM 提供者设置"` inside `"header"`, then add the top-level `"llmConfig"` block with Chinese translations (mirror the structure of the en.json block above). Acceptable starter translations:

```json
  "llmConfig": {
    "title": "LLM 提供者设置",
    "description": "配置 LLM、嵌入和重排序提供者。安全变更会立即生效。",
    "loading": "正在加载当前配置…",
    "saving": "保存中…",
    "save": "保存",
    "cancel": "取消",
    "sourceLabel": "来源",
    "apiKeyHint": "保持原值不变即可复用现有密钥。",
    "toastApplied": "配置已应用。",
    "toastRestartRequired": "已清除索引数据 — 请重启 LightRAG 完成变更。",
    "toastStale": "配置已被其他人修改,已重新加载最新版本。",
    "toastForbidden": "需要管理员权限。",
    "source": { "overlay": "运行时", "env": "环境文件" },
    "tabs": { "llm": "LLM", "embedding": "嵌入", "rerank": "重排序" },
    "llm": {
      "binding": "绑定",
      "preset": "OpenAI 兼容预设",
      "presetPlaceholder": "选择预设以自动填充 Host",
      "host": "Host",
      "model": "模型",
      "apiKey": "API 密钥",
      "maxAsync": "最大并发",
      "timeout": "超时 (秒)",
      "temperature": "Temperature",
      "maxTokens": "最大 tokens"
    },
    "embedding": {
      "binding": "绑定",
      "host": "Host",
      "model": "模型",
      "apiKey": "API 密钥",
      "dim": "维度",
      "tokenLimit": "Token 上限",
      "sendDim": "发送维度",
      "timeout": "超时 (秒)",
      "hasDataWarning": "警告: 已存在索引数据。更改绑定/模型/维度将清空所有索引数据。"
    },
    "rerank": {
      "enabled": "启用",
      "binding": "绑定",
      "host": "Host",
      "model": "模型",
      "apiKey": "API 密钥"
    },
    "destructive": {
      "title": "破坏性变更",
      "body": "所选的嵌入变更需要清空全部索引数据,且此操作不可撤销。",
      "typePrompt": "输入 CLEAR 以确认",
      "cancel": "取消",
      "confirm": "清空并应用"
    },
    "restartRequired": {
      "title": "需要重启",
      "body": "索引数据已清空。请重启 LightRAG 服务以激活新的嵌入模型。"
    }
  }
```

Other locale files (fr, ja, etc.) fall back to English via i18next; leave them untouched.

- [ ] **Step 5: Lint and type-check**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun run lint
```

Expected: clean.

- [ ] **Step 6: Build the WebUI**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun run build
```

Expected: build succeeds. Output goes to `dist/`.

- [ ] **Step 7: Commit**

```bash
cd /Users/lance/LaboFlow
git add LightRAG/lightrag_webui/src/features/LLMConfigButton.tsx LightRAG/lightrag_webui/src/features/SiteHeader.tsx LightRAG/lightrag_webui/src/locales/en.json LightRAG/lightrag_webui/src/locales/zh.json
git commit -m "feat(webui): wire LLMConfigButton into SiteHeader with i18n"
```

Also commit the rebuilt WebUI assets if the repo tracks `dist/`:

```bash
git add LightRAG/lightrag_webui/dist
git commit -m "chore(webui): rebuild for LLM config dialog"
```

(If `dist/` is `.gitignore`d, skip the second commit — the dev.sh script rebuilds on startup.)

---

## Task 16: Manual smoke test

**Files:** none (verification only)

Spec reference: §8.3. This task produces no code changes but MUST be completed before claiming the feature is done. Follow `superpowers:verification-before-completion`.

- [ ] **Step 1: Restart LightRAG with the new code**

Ask the user to restart the LightRAG server (do NOT restart it yourself — see session feedback: the user manages their own dev stack). Tell them:

> "Please restart LightRAG (it's managed by `dev.sh` on port 9621). The runtime_config feature requires a full process restart to pick up the new router and the SSO role patch."

Wait for the user to confirm the restart is complete before continuing.

- [ ] **Step 2: Verify the gear icon appears for admins**

Log in to LaboFlow Clawith with a `platform_admin` account, then navigate to the knowledge base module (`/kb/`). Confirm:

- [ ] A gear icon appears between the palette icon and the logout button in the top-right of the LightRAG header.
- [ ] Clicking the gear opens a modal dialog titled "LLM provider settings".
- [ ] All three tabs (LLM / Embedding / Rerank) are accessible.
- [ ] API key fields show the masked format `abc••••xy` (not the raw key).
- [ ] Each section shows a "Source: env" or "Source: runtime" badge.

If the gear is missing, check the JWT payload in browser devtools → Application → Local Storage → `LIGHTRAG-API-TOKEN`. Decode it at jwt.io to verify `role === "platform_admin"`.

- [ ] **Step 3: Hot-swap an LLM model**

In the dialog:
1. Change `llm.model` from its current value to something different (e.g. `gpt-4o-mini` → `gpt-4o`).
2. Click Save.
3. Expect a success toast and the dialog to close.
4. Open the dialog again and verify the new model is persisted.
5. Verify `LightRAG/runtime_config.json` exists on disk with mode `0600` and contains the new value. Run (ask user to run if sandboxed):
   ```bash
   ls -la /Users/lance/LaboFlow/LightRAG/rag_storage/runtime_config.json
   cat /Users/lance/LaboFlow/LightRAG/rag_storage/runtime_config.json
   ```
6. Issue a test query through the WebUI; confirm the LightRAG logs show the new model name.

- [ ] **Step 4: Hot-swap the embedding host (not the model)**

Change `embedding.host` to a different value while keeping `embedding.binding`, `embedding.model`, `embedding.dim` unchanged. Save. Expect success toast; no destructive confirm.

- [ ] **Step 5: Destructive embedding model change**

Change `embedding.model` to a new model with a different dimension. Save. Expect:
- A destructive confirm block appears listing files that will be cleared.
- The Apply button is disabled until you type `CLEAR` into the confirm field.
- After confirming, you get a "Restart required" banner with the list of deleted files.
- `ls /Users/lance/LaboFlow/LightRAG/rag_storage/` shows no `vdb_*.json` or `kv_store_text_chunks.json`.

Ask the user to restart LightRAG and verify the new embedding model is now active.

- [ ] **Step 6: Non-admin visibility**

Log in with a non-admin Clawith user. Navigate to `/kb/`. Confirm the gear icon is NOT present.

Open DevTools and attempt a direct call:

```javascript
fetch('/kb-api/llm-config', {
  headers: { Authorization: `Bearer ${localStorage.getItem('LIGHTRAG-API-TOKEN')}` }
}).then((r) => r.status)
```

Expected: 403. This confirms server-side gating works independently of the UI.

- [ ] **Step 7: Generation race simulation**

In one browser tab, open the dialog. In a second tab (still admin), open the dialog and save a change. In the first tab, try to save — expect the stale-config toast and an automatic reload.

- [ ] **Step 8: Summarize results**

Write up one paragraph of what passed, what failed, and what user follow-up is needed (e.g. restart reminder). Share with the user.

- [ ] **Step 9: Commit any docs updates**

If any step produced a small code fix, commit it separately with a `fix(llm-config): ...` message. Otherwise, nothing to commit.

---

## Spec coverage checklist

Before declaring the plan complete, verify each spec section has a task:

| Spec section | Task(s) |
|---|---|
| §1 Goals: gear icon in header | 15 |
| §1 Goals: 3-surface UI | 11, 12, 13, 14 |
| §1 Goals: persistence across restart | 1, 8 |
| §1 Goals: hot-swap for non-destructive | 3, 7 |
| §1 Goals: destructive confirm flow | 4, 7, 12 |
| §1 Goals: platform_admin gating | 5, 6, 9, 15 |
| §2.2 hot-swap vs rebuild classification | 2 |
| §2.3 SSO role forwarding | 5 |
| §4.1 Runtime config overlay format | 1 |
| §4.2 API request/response | 6, 7, 10 |
| §5.1 runtime_config.py | 1 |
| §5.2 llm_config_apply.py | 2, 3, 4 |
| §5.3 llm_config_routes.py | 6, 7 |
| §5.4 lightrag_server.py edits | 5, 8 |
| §5.5 dialog structure | 11, 12, 13, 14 |
| §5.6 llmProviderPresets.ts | 10 |
| §5.7 SiteHeader edit + auth-store role | 9, 15 |
| §6.1 boot-time load | 1, 8 |
| §6.2 hot-swap flow | 3, 7 |
| §6.3 destructive flow | 4, 7 |
| §6.4 masked-key sentinel | 1, 7, 10 |
| §7 Error invariants | 3, 4, 7 |
| §8 Testing plan | 1–7, 10, 16 |

Every spec section is covered. If you add, remove, or reorder tasks, re-run this table.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-11-lightrag-llm-provider-settings.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
