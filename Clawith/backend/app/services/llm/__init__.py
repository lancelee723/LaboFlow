"""LLM service package.

Provides the unified LLM client classes (via client.py) and the high-level
call_llm / call_llm_with_failover helpers used across the application.
"""

import json

from sqlalchemy import select

from app.database import async_session
from app.models.llm import LLMModel

# Re-export all client classes and functions from client.py
from app.services.llm.client import (
    AnthropicClient,
    GeminiClient,
    LLMClient,
    LLMError,
    LLMMessage,
    LLMResponse,
    LLMStreamChunk,
    OpenAICompatibleClient,
    OpenAIResponsesClient,
    PROVIDER_ALIASES,
    PROVIDER_REGISTRY,
    ProviderSpec,
    PROVIDER_URLS,
    TOOL_CHOICE_PROVIDERS,
    MAX_TOKENS_BY_PROVIDER,
    MAX_TOKENS_BY_MODEL,
    chat_complete,
    chat_stream,
    create_llm_client,
    get_max_tokens,
    get_provider_manifest,
    get_provider_base_url,
    get_provider_spec,
    normalize_provider,
)


# ── Error-string helpers ──────────────────────────────────────────────────────

def _is_llm_error(result: str) -> bool:
    """Return True if call_llm returned an error string rather than real content."""
    return result.startswith(("[LLM Error]", "[LLM call error]", "[Error]"))


# ── High-level call helpers ───────────────────────────────────────────────────

async def call_llm(
    model: LLMModel,
    messages: list[dict],
    agent_name: str,
    role_description: str,
    agent_id=None,
    user_id=None,
    session_id: str = "",
    on_chunk=None,
    on_tool_call=None,
    on_thinking=None,
    supports_vision=False,
    max_tool_rounds_override: int | None = None,
) -> str:
    """Call LLM via unified client with function-calling tool loop.

    Args:
        on_chunk: Optional async callback(text: str) for streaming chunks to client.
        on_thinking: Optional async callback(text: str) for reasoning/thinking content.
        on_tool_call: Optional async callback(dict) for tool call status updates.
    """
    from app.services.agent_tools import AGENT_TOOLS, execute_tool, get_agent_tools_for_llm
    from app.services.llm_utils import create_llm_client, get_max_tokens, LLMMessage, LLMError, get_model_api_key

    # ── Token limit check & config ──
    _max_tool_rounds = 50  # default
    if agent_id:
        try:
            from app.models.agent import Agent as AgentModel
            async with async_session() as _db:
                _ar = await _db.execute(select(AgentModel).where(AgentModel.id == agent_id))
                _agent = _ar.scalar_one_or_none()
                if _agent:
                    _max_tool_rounds = _agent.max_tool_rounds or 50
                    if max_tool_rounds_override and max_tool_rounds_override < _max_tool_rounds:
                        _max_tool_rounds = max_tool_rounds_override
                    if _agent.max_tokens_per_day and _agent.tokens_used_today >= _agent.max_tokens_per_day:
                        return f"⚠️ Daily token usage has reached the limit ({_agent.tokens_used_today:,}/{_agent.max_tokens_per_day:,}). Please try again tomorrow or ask admin to increase the limit."
                    if _agent.max_tokens_per_month and _agent.tokens_used_month >= _agent.max_tokens_per_month:
                        return f"⚠️ Monthly token usage has reached the limit ({_agent.tokens_used_month:,}/{_agent.max_tokens_per_month:,}). Please ask admin to increase the limit."
        except Exception:
            pass

    if max_tool_rounds_override and max_tool_rounds_override < _max_tool_rounds:
        _max_tool_rounds = max_tool_rounds_override

    # Build rich prompt with soul, memory, skills, relationships
    from app.services.agent_context import build_agent_context
    # Look up current user's display name so the agent knows who it's talking to
    _current_user_name = None
    if user_id:
        try:
            from app.models.user import User as _UserModel
            async with async_session() as _udb:
                _ur = await _udb.execute(select(_UserModel).where(_UserModel.id == user_id))
                _u = _ur.scalar_one_or_none()
                if _u:
                    _current_user_name = _u.display_name or _u.username
        except Exception:
            pass
    static_prompt, dynamic_prompt = await build_agent_context(agent_id, agent_name, role_description, current_user_name=_current_user_name)

    # Load tools dynamically from DB
    tools_for_llm = await get_agent_tools_for_llm(agent_id) if agent_id else AGENT_TOOLS

    # Convert messages to LLMMessage format
    api_messages = [LLMMessage(role="system", content=static_prompt, dynamic_content=dynamic_prompt)]
    for msg in messages:
        api_messages.append(LLMMessage(
            role=msg.get("role", "user"),
            content=msg.get("content"),
            tool_calls=msg.get("tool_calls"),
            tool_call_id=msg.get("tool_call_id"),
        ))

    # ── Vision format conversion ──
    # If the model supports vision, convert image markers in user messages
    # to OpenAI Vision API format: content becomes an array of parts.
    if supports_vision:
        import re as _re_v
        for i, msg in enumerate(api_messages):
            if msg.role != "user" or not msg.content or not isinstance(msg.content, str):
                continue
            content_str = msg.content
            # Find [image_data:data:image/...;base64,...] markers
            pattern = r'\[image_data:(data:image/[^;]+;base64,[A-Za-z0-9+/=]+)\]'
            images = _re_v.findall(pattern, content_str)
            if not images:
                continue
            # Build content array
            text = _re_v.sub(pattern, '', content_str).strip()
            parts = []
            for img_url in images:
                parts.append({"type": "image_url", "image_url": {"url": img_url}})
            if text:
                parts.append({"type": "text", "text": text})
            # Replace the message content with the array format
            api_messages[i] = LLMMessage(
                role=msg.role,
                content=parts,  # type: ignore  # This is valid for vision models
            )
    else:
        # Strip base64 image markers for non-vision models to avoid wasting tokens
        import re as _re_strip
        _img_pattern = r'\[image_data:data:image/[^;]+;base64,[A-Za-z0-9+/=]+\]'
        for i, msg in enumerate(api_messages):
            if msg.role != "user" or not isinstance(msg.content, str):
                continue
            if "[image_data:" in msg.content:
                _n_imgs = len(_re_strip.findall(_img_pattern, msg.content))
                cleaned = _re_strip.sub(_img_pattern, '', msg.content).strip()
                if _n_imgs > 0:
                    cleaned += f"\n[用户发送了 {_n_imgs} 张图片，但当前模型不支持视觉，无法查看图片内容]"
                api_messages[i] = LLMMessage(
                    role=msg.role,
                    content=cleaned,
                )

    # Create the unified LLM client
    try:
        client = create_llm_client(
            provider=model.provider,
            api_key=get_model_api_key(model),
            model=model.model,
            base_url=model.base_url,
            timeout=float(getattr(model, 'request_timeout', None) or 120.0),
        )
    except Exception as e:
        return f"[Error] Failed to create LLM client: {e}"

    max_tokens = get_max_tokens(model.provider, model.model, getattr(model, 'max_output_tokens', None))

    # ── Per-round token accumulator ──
    from app.services.token_tracker import record_token_usage, extract_usage_tokens, estimate_tokens_from_chars
    _accumulated_tokens = 0

    # Tool-calling loop (configurable per agent, default 50)
    for round_i in range(_max_tool_rounds):
        # ── Dynamic tool-call limit warning (Aware engine) ──
        # Don't tell the agent about limits at the start — only warn when approaching.
        # This prevents models from rushing to complete tasks prematurely.
        _warn_threshold_80 = int(_max_tool_rounds * 0.8)
        _warn_threshold_96 = _max_tool_rounds - 2
        if round_i == _warn_threshold_80:
            api_messages.append(LLMMessage(
                role="user",
                content=(
                    f"⚠️ 你已使用 {round_i}/{_max_tool_rounds} 轮工具调用。"
                    "如果当前任务尚未完成，请尽快保存进度到 focus.md，"
                    "并使用 set_trigger 设置续接触发器，在剩余轮次中做好收尾。"
                ),
            ))
        elif round_i == _warn_threshold_96:
            api_messages.append(LLMMessage(
                role="user",
                content=f"🚨 仅剩 2 轮工具调用。请立即保存进度到 focus.md 并设置续接触发器。",
            ))

        try:
            # Use streaming API for real-time responses
            response = await client.stream(
                messages=api_messages,
                tools=tools_for_llm if tools_for_llm else None,
                temperature=model.temperature,
                max_tokens=max_tokens,
                on_chunk=on_chunk,
                on_thinking=on_thinking,
            )
        except LLMError as e:
            from loguru import logger
            # Record accumulated tokens before returning error
            logger.error(
                f"[LLM] LLMError provider={getattr(model, 'provider', '?')} "
                f"model={getattr(model, 'model', '?')} round={round_i + 1}: {e}"
            )
            if agent_id and _accumulated_tokens > 0:
                await record_token_usage(agent_id, _accumulated_tokens)
            return f"[LLM Error] {e}"
        except Exception as e:
            from loguru import logger
            logger.error(
                f"[LLM] Unexpected error provider={getattr(model, 'provider', '?')} "
                f"model={getattr(model, 'model', '?')} round={round_i + 1}: "
                f"{type(e).__name__}: {str(e)[:300]}"
            )
            if agent_id and _accumulated_tokens > 0:
                await record_token_usage(agent_id, _accumulated_tokens)
            return f"[LLM call error] {type(e).__name__}: {str(e)[:200]}"

        # ── Track tokens for this round ──
        from loguru import logger
        logger.debug(f"[LLM] stream() returned: {len(response.content or '')} chars, finish={response.finish_reason}, tools={len(response.tool_calls or [])}")
        real_tokens = extract_usage_tokens(response.usage)
        if real_tokens:
            _accumulated_tokens += real_tokens
        else:
            round_chars = sum(len(m.content or '') if isinstance(m.content, str) else 0 for m in api_messages) + len(response.content or '')
            _accumulated_tokens += estimate_tokens_from_chars(round_chars)

        # If no tool calls, return the final content
        if not response.tool_calls:
            if agent_id and _accumulated_tokens > 0:
                await record_token_usage(agent_id, _accumulated_tokens)
            await client.close()
            return response.content or "[LLM returned empty content]"

        # Execute tool calls
        logger.info(f"[LLM] Round {round_i+1}: {len(response.tool_calls)} tool call(s), finish_reason={response.finish_reason}")

        # Add assistant message with tool calls
        api_messages.append(LLMMessage(
            role="assistant",
            content=response.content or None,
            tool_calls=[{
                "id": tc["id"],
                "type": "function",
                "function": tc["function"],
            } for tc in response.tool_calls],
            reasoning_content=response.reasoning_content,
        ))

        full_reasoning_content = response.reasoning_content or ""

        # Tools that require arguments — if LLM sends empty args, skip and ask to retry
        _TOOLS_REQUIRING_ARGS = {"write_file", "read_file", "delete_file", "read_document", "send_message_to_agent", "send_feishu_message", "send_email"}

        for tc in response.tool_calls:
            fn = tc["function"]
            tool_name = fn["name"]
            raw_args = fn.get("arguments", "{}")
            logger.info(f"[LLM] Raw arguments for {tool_name} (len={len(raw_args)}): {repr(raw_args[:300])}")
            try:
                args = json.loads(raw_args) if raw_args else {}
            except json.JSONDecodeError:
                args = {}

            # Guard: if a tool that requires arguments received empty args,
            # return an error to LLM instead of executing (Claude sometimes
            # emits tool_use blocks with no input_json_delta events)
            if not args and tool_name in _TOOLS_REQUIRING_ARGS:
                logger.warning(f"[LLM] Empty arguments for {tool_name}, asking LLM to retry")
                api_messages.append(LLMMessage(
                    role="tool",
                    content=f"Error: {tool_name} was called with empty arguments. You must provide the required parameters. Please retry with the correct arguments.",
                    tool_call_id=tc.get("id", ""),
                ))
                continue

            logger.info(f"[LLM] Calling tool: {tool_name}({args})")
            # Notify client about tool call (in-progress)
            if on_tool_call:
                try:
                    await on_tool_call({
                        "name": tool_name,
                        "args": args,
                        "status": "running",
                        "reasoning_content": full_reasoning_content
                    })
                except Exception:
                    pass

            result = await execute_tool(
                tool_name, args,
                agent_id=agent_id,
                user_id=user_id or agent_id,
                session_id=session_id,
            )
            logger.debug(f"[LLM] Tool result: {result[:100]}")

            # Notify client about tool call result
            if on_tool_call:
                try:
                    await on_tool_call({
                        "name": tool_name,
                        "args": args,
                        "status": "done",
                        "result": result,
                        "reasoning_content": full_reasoning_content
                    })
                except Exception as _cb_err:
                    logger.warning(f"[LLM] on_tool_call callback error: {_cb_err}")

            # ── Vision injection for screenshot tools ──
            # If the model supports vision, try to inject the actual screenshot
            # image into the tool result so the LLM can SEE what's on screen.
            # Without this, the LLM only gets text like "Screenshot saved to ..."
            # and blindly guesses the page content.
            tool_content: str | list = str(result)
            if supports_vision and agent_id:
                try:
                    from app.services.vision_inject import try_inject_screenshot_vision
                    from app.services.agent_tools import WORKSPACE_ROOT
                    ws_path = WORKSPACE_ROOT / str(agent_id)
                    vision_content = try_inject_screenshot_vision(tool_name, str(result), ws_path)
                    if vision_content:
                        tool_content = vision_content
                        logger.info(f"[LLM] Injected screenshot vision for {tool_name}")
                except Exception as e:
                    logger.warning(f"[LLM] Vision injection failed for {tool_name}: {e}")

            api_messages.append(LLMMessage(
                role="tool",
                tool_call_id=tc["id"],
                content=tool_content,
            ))

    # Record tokens even on "too many rounds" exit
    if agent_id and _accumulated_tokens > 0:
        await record_token_usage(agent_id, _accumulated_tokens)
    await client.close()
    return "[Error] Too many tool call rounds"


async def call_llm_with_failover(
    primary_model: LLMModel,
    fallback_model: LLMModel | None,
    messages: list[dict],
    agent_name: str,
    role_description: str,
    agent_id=None,
    user_id=None,
    session_id: str = "",
    on_chunk=None,
    on_tool_call=None,
    on_thinking=None,
    supports_vision=False,
    on_failover=None,
) -> str:
    """Call primary LLM and automatically fall back to fallback_model on error.

    Args:
        on_failover: Optional async callback(reason: str) called when switching to fallback.
    """
    result = await call_llm(
        primary_model, messages, agent_name, role_description,
        agent_id=agent_id, user_id=user_id, session_id=session_id,
        on_chunk=on_chunk, on_tool_call=on_tool_call, on_thinking=on_thinking,
        supports_vision=supports_vision,
    )

    if _is_llm_error(result) and fallback_model is not None:
        if on_failover:
            try:
                await on_failover(result)
            except Exception:
                pass
        result = await call_llm(
            fallback_model, messages, agent_name, role_description,
            agent_id=agent_id, user_id=user_id, session_id=session_id,
            on_chunk=on_chunk, on_tool_call=on_tool_call, on_thinking=on_thinking,
            supports_vision=supports_vision,
        )

    return result


__all__ = [
    # Client classes
    "LLMClient",
    "OpenAICompatibleClient",
    "OpenAIResponsesClient",
    "GeminiClient",
    "AnthropicClient",
    "LLMMessage",
    "LLMResponse",
    "LLMStreamChunk",
    "LLMError",
    # Functions
    "create_llm_client",
    "chat_complete",
    "chat_stream",
    "call_llm",
    "call_llm_with_failover",
    # Constants
    "ProviderSpec",
    "PROVIDER_ALIASES",
    "PROVIDER_REGISTRY",
    "PROVIDER_URLS",
    "TOOL_CHOICE_PROVIDERS",
    "MAX_TOKENS_BY_PROVIDER",
    "MAX_TOKENS_BY_MODEL",
    # Registry helpers
    "normalize_provider",
    "get_provider_spec",
    "get_provider_manifest",
    "get_provider_base_url",
    "get_max_tokens",
]
