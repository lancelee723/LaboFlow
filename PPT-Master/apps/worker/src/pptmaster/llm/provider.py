"""LLM provider abstraction — ChatModel factory backed by a provider registry.

The registry (single source of truth) is synced from Clawith's
PROVIDER_REGISTRY in app/services/llm/client.py. Each entry declares the
protocol and default base URL; build_chat_model_from_config resolves the
correct LangChain ChatModel class from the protocol.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from langchain_core.language_models.chat_models import BaseChatModel

from pptmaster.config import get_settings
from pptmaster.db.models import LLMConfig
from pptmaster.db.session import get_async_session_factory

logger = logging.getLogger(__name__)


async def record_token_usage(
    user_id: str,
    project_id: str,
    session_id: str,
    agent_role: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Write a token usage row to the database (best-effort, non-fatal)."""
    try:
        from pptmaster.db.models import LLMUsage

        async with get_async_session_factory()() as db:
            db.add(LLMUsage(
                user_id=user_id,
                project_id=project_id,
                session_id=session_id,
                agent_role=agent_role,
                provider=provider,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            ))
            await db.commit()
    except Exception:
        logger.debug("Token usage record failed (non-fatal)", exc_info=True)


# ── Provider registry (synced from Clawith) ────────────────────────────────


@dataclass(frozen=True)
class ProviderSpec:
    provider: str
    display_name: str
    protocol: Literal["openai_compatible", "anthropic", "gemini"]
    default_base_url: str | None
    default_model: str  #  model suggested when the user picks this provider


PROVIDER_REGISTRY: dict[str, ProviderSpec] = {
    "anthropic": ProviderSpec(
        provider="anthropic",
        display_name="Anthropic (Claude)",
        protocol="anthropic",
        default_base_url="https://api.anthropic.com",
        default_model="claude-sonnet-4-20250514",
    ),
    "openai": ProviderSpec(
        provider="openai",
        display_name="OpenAI (GPT)",
        protocol="openai_compatible",
        default_base_url="https://api.openai.com/v1",
        default_model="gpt-4o",
    ),
    "deepseek": ProviderSpec(
        provider="deepseek",
        display_name="DeepSeek",
        protocol="openai_compatible",
        default_base_url="https://api.deepseek.com/v1",
        default_model="deepseek-chat",
    ),
    "qwen": ProviderSpec(
        provider="qwen",
        display_name="Qwen (DashScope)",
        protocol="openai_compatible",
        default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model="qwen-plus",
    ),
    "gemini": ProviderSpec(
        provider="gemini",
        display_name="Google (Gemini)",
        protocol="gemini",
        default_base_url="https://generativelanguage.googleapis.com/v1beta",
        default_model="gemini-2.5-flash",
    ),
    "zhipu": ProviderSpec(
        provider="zhipu",
        display_name="Zhipu (GLM)",
        protocol="openai_compatible",
        default_base_url="https://open.bigmodel.cn/api/paas/v4",
        default_model="glm-4-flash",
    ),
    "kimi": ProviderSpec(
        provider="kimi",
        display_name="Kimi (Moonshot)",
        protocol="openai_compatible",
        default_base_url="https://api.moonshot.cn/v1",
        default_model="moonshot-v1-8k",
    ),
    "minimax": ProviderSpec(
        provider="minimax",
        display_name="MiniMax",
        protocol="openai_compatible",
        default_base_url="https://api.minimaxi.com/v1",
        default_model="abab6.5s-chat",
    ),
    "baidu": ProviderSpec(
        provider="baidu",
        display_name="Baidu (Qianfan)",
        protocol="openai_compatible",
        default_base_url="https://qianfan.baidubce.com/v2",
        default_model="ernie-speed-128k",
    ),
    "openrouter": ProviderSpec(
        provider="openrouter",
        display_name="OpenRouter",
        protocol="openai_compatible",
        default_base_url="https://openrouter.ai/api/v1",
        default_model="openai/gpt-4o",
    ),
    "ollama": ProviderSpec(
        provider="ollama",
        display_name="Ollama (local)",
        protocol="openai_compatible",
        default_base_url=None,  # user must supply endpoint
        default_model="llama3",
    ),
    "vllm": ProviderSpec(
        provider="vllm",
        display_name="vLLM",
        protocol="openai_compatible",
        default_base_url="http://localhost:8000/v1",
        default_model="",
    ),
}


def get_provider_spec(provider: str) -> ProviderSpec | None:
    return PROVIDER_REGISTRY.get((provider or "").strip().lower())


def resolve_base_url(provider: str, custom_endpoint: str | None) -> str | None:
    """Return the effective base URL: custom first, then registry default."""
    if custom_endpoint:
        return custom_endpoint
    spec = get_provider_spec(provider)
    return spec.default_base_url if spec else None


# ── Runtime LLM resolution ──────────────────────────────────────────────────


async def get_chat_model(role: str) -> BaseChatModel:
    """Return a ChatModel instance by querying the DB llm_configs table.

    Priority:
      1. Config with matching role_preference (e.g. strategist)
      2. Config with is_default = True
      3. First available config
      4. Environment variable fallback (ANTHROPIC_API_KEY / OPENAI_API_KEY)
    """
    settings = get_settings()

    async with get_async_session_factory()() as db:
        from sqlalchemy import select

        rows = (await db.execute(
            select(LLMConfig)
        )).scalars().all()

        if rows:
            for cfg in rows:
                if cfg.role_preference == role:
                    return build_chat_model_from_config(cfg)
            for cfg in rows:
                if cfg.is_default:
                    return build_chat_model_from_config(cfg)
            return build_chat_model_from_config(rows[0])

    # Env var fallback
    if settings.anthropic_api_key:
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model="claude-sonnet-4-20250514", api_key=settings.anthropic_api_key, temperature=0.7)
    if settings.openai_api_key:
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model="gpt-4o", api_key=settings.openai_api_key, temperature=0.7)

    import os
    if os.environ.get("ANTHROPIC_API_KEY"):
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model="claude-sonnet-4-20250514", temperature=0.7)
    if os.environ.get("OPENAI_API_KEY"):
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model="gpt-4o", temperature=0.7)

    raise RuntimeError(
        "No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, "
        "or configure a provider in /settings/llm."
    )


def _read_api_key(config: LLMConfig) -> str | None:
    if not config.api_key_encrypted:
        return None
    return config.api_key_encrypted.decode("utf-8")


def build_chat_model_from_config(config: LLMConfig) -> BaseChatModel:
    """Build a LangChain ChatModel from a stored LLMConfig row.

    Uses the provider registry for the default base URL when the user
    hasn't supplied a custom endpoint.  Protocol dispatch:

      anthropic  → ChatAnthropic
      gemini     → ChatGoogleGenerativeAI
      everything else (openai / deepseek / qwen / zhipu / kimi / ...)
                 → ChatOpenAI  (OpenAI-compatible protocol)
    """
    api_key = _read_api_key(config)
    provider = (config.provider or "").strip().lower()
    spec = get_provider_spec(provider)
    base_url = resolve_base_url(provider, config.endpoint)

    # -- Anthropic native ----------------------------------------------------
    if spec and spec.protocol == "anthropic":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=config.model or spec.default_model,
            api_key=api_key,
            base_url=base_url,
            temperature=0.0,
            max_tokens=10,
        )

    # -- Gemini (Google) -----------------------------------------------------
    if spec and spec.protocol == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=config.model or spec.default_model,
            google_api_key=api_key,
            temperature=0.0,
        )

    # -- OpenAI-compatible (covers openai, deepseek, qwen, zhipu, kimi, …) --
    spec = spec or PROVIDER_REGISTRY.get(
        provider, ProviderSpec(provider=provider, display_name=provider,
                               protocol="openai_compatible", default_base_url=None,
                               default_model=config.model)
    )

    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=config.model or spec.default_model,
        api_key=api_key or "not-needed",
        base_url=base_url,
        temperature=0.0,
        max_tokens=10,
    )
