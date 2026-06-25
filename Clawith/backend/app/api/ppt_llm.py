"""Pro Slides LLM streaming endpoint.

Provides SSE-based LLM streaming for Pro Slides generation pipeline.
Wraps Clawith's create_llm_client + client.stream() directly,
keeping API keys server-side.
"""

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt as jose_jwt
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.agent import Agent
from app.models.llm import LLMModel
from app.models.user import User
from app.services.llm.utils import create_llm_client, get_model_api_key, LLMMessage

router = APIRouter(prefix="/ppt/llm", tags=["ppt-llm"])

# ── SSO Auth sub-router ─────────────────────────────────────
auth_router = APIRouter(prefix="/ppt/auth", tags=["ppt-auth"])

_bearer = HTTPBearer()


async def get_pro_slides_sso_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Validate a Pro Slides SSO token (aud='pro-slides') and return the user."""
    try:
        payload = jose_jwt.decode(
            credentials.credentials,
            get_settings().JWT_SECRET_KEY,
            algorithms=[get_settings().JWT_ALGORITHM],
            audience="pro-slides",
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired SSO token",
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SSO token")

    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SSO token")

    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(User)
        .where(User.id == uid)
        .options(selectinload(User.identity))
    )
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return user


@auth_router.get("/me")
async def get_ppt_user_info(
    current_user: User = Depends(get_pro_slides_sso_user),
):
    """Return user info for a Pro Slides SSO token."""
    return {
        "id": str(current_user.id),
        "email": current_user.email or "",
        "display_name": current_user.display_name or "",
        "role": current_user.role,
        "tenant_id": str(current_user.tenant_id) if current_user.tenant_id else None,
    }


class SSOVerifyRequest(BaseModel):
    token: str


@auth_router.post("/sso/verify")
async def verify_sso_token(
    req: SSOVerifyRequest,
    db: AsyncSession = Depends(get_db),
):
    """Verify a Pro Slides SSO token and return user + session token.

    This replaces the old daemon's /api/sso/verify endpoint.
    The SSO token (aud='pro-slides', short-lived) is validated,
    then a longer-lived Clawith access token is minted as the session_token.
    """
    try:
        payload = jose_jwt.decode(
            req.token,
            get_settings().JWT_SECRET_KEY,
            algorithms=[get_settings().JWT_ALGORITHM],
            audience="pro-slides",
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired SSO token",
        )

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SSO token")

    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid SSO token")

    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(User).where(User.id == uid).options(selectinload(User.identity))
    )
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    from app.core.security import create_access_token

    session_token = create_access_token(str(user.id), user.role)

    return {
        "user": {
            "id": str(user.id),
            "email": user.email or "",
            "display_name": user.display_name or "",
            "role": user.role,
        },
        "session_token": session_token,
    }


@auth_router.get("/agent-id")
async def get_ppt_agent_id(
    current_user: User = Depends(get_pro_slides_sso_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the PPT Agent ID for this tenant.

    Pro Slides frontend calls this at startup to discover which agent
    to connect to via WebSocket.
    """
    result = await db.execute(
        select(Agent).where(
            Agent.name == "PPT Agent",
            Agent.is_system == True,  # noqa: E712
            Agent.tenant_id == current_user.tenant_id,
        ).limit(1)
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="PPT Agent not found. Please restart Clawith to seed it.",
        )
    return {"agent_id": str(agent.id)}


# ── Schemas ──────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str = Field(..., pattern=r"^(system|user|assistant)$")
    content: str


class StreamRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_length=1)
    model_id: str | None = None
    temperature: float | None = Field(None, ge=0, le=2)
    max_tokens: int | None = Field(None, ge=1)


class ModelInfo(BaseModel):
    id: str
    provider: str
    model: str
    label: str
    supports_vision: bool = False


class ModelsResponse(BaseModel):
    models: list[ModelInfo]


# ── Model resolution ─────────────────────────────────────────

async def _resolve_model(
    model_id: str | None,
    user: User,
    db: AsyncSession,
) -> tuple[str, str, str, str | None]:
    """Resolve model_id → (provider, model, api_key, base_url).

    Falls back to aippt_llm_config from SystemSetting if no model_id given.
    """
    if model_id:
        result = await db.execute(
            select(LLMModel).where(
                LLMModel.id == uuid.UUID(model_id),
                LLMModel.enabled.is_(True),
            )
        )
        llm_model = result.scalar_one_or_none()
        if not llm_model:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"LLM model {model_id} not found or disabled",
            )
        if llm_model.tenant_id and llm_model.tenant_id != user.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Model not available for your tenant",
            )
        api_key = get_model_api_key(llm_model)
        return llm_model.provider, llm_model.model, api_key, llm_model.base_url

    # Fallback: read aippt_llm_config from SystemSetting
    from app.models.system_settings import SystemSetting

    result = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "aippt_llm_config")
    )
    setting = result.scalar_one_or_none()
    if not setting or not setting.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model specified and no aippt_llm_config found. "
                   "Please select a model or configure default LLM in enterprise settings.",
        )

    config = setting.value
    provider = config.get("provider", "deepseek")
    model = config.get("model", "deepseek-chat")
    base_url = config.get("baseUrl") or None
    api_keys = config.get("apiKeys", {})
    api_key = ""
    if api_keys:
        api_key = api_keys.get(provider, next(iter(api_keys.values()), ""))

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No API key configured for the default LLM model",
        )

    return provider, model, api_key, base_url


# ── SSE Streaming ────────────────────────────────────────────

@router.post("/stream")
async def stream_llm(
    req: StreamRequest,
    current_user: User = Depends(get_pro_slides_sso_user),
    db: AsyncSession = Depends(get_db),
):
    """SSE streaming endpoint for Pro Slides LLM calls.

    client.stream() returns an aggregated LLMResponse but emits chunks
    via on_chunk/on_thinking callbacks. We bridge these callbacks to SSE
    using an asyncio.Queue.
    """
    provider, model, api_key, base_url = await _resolve_model(
        req.model_id, current_user, db
    )

    # Queue bridges callbacks → SSE generator
    queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def on_chunk(content: str):
        await queue.put(json.dumps({"type": "chunk", "content": content}))

    async def on_thinking(content: str):
        await queue.put(json.dumps({"type": "thinking", "content": content}))

    async def run_stream():
        """Run client.stream() in background, pushing events to queue."""
        try:
            client = create_llm_client(
                provider=provider,
                api_key=api_key,
                model=model,
                base_url=base_url,
            )
            llm_messages = [LLMMessage(role=m.role, content=m.content) for m in req.messages]

            response = await client.stream(
                messages=llm_messages,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
                on_chunk=on_chunk,
                on_thinking=on_thinking,
            )
            # Stream completed — send done event with full content
            await queue.put(json.dumps({"type": "done", "content": response.content or ""}))
        except Exception as e:
            logger.error(f"[ppt-llm] Stream error: {e}")
            await queue.put(json.dumps({"type": "error", "content": "LLM stream failed"}))
        finally:
            # Signal end of stream
            await queue.put(None)

    async def event_generator():
        # Start the LLM stream as a background task
        stream_task = asyncio.create_task(run_stream())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {event}\n\n"
        except asyncio.CancelledError:
            stream_task.cancel()
            raise

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Available Models ─────────────────────────────────────────

@router.get("/models", response_model=ModelsResponse)
async def list_models(
    current_user: User = Depends(get_pro_slides_sso_user),
    db: AsyncSession = Depends(get_db),
):
    """List LLM models available for the current user's tenant."""
    result = await db.execute(
        select(LLMModel).where(
            LLMModel.enabled.is_(True),
            (LLMModel.tenant_id == current_user.tenant_id)
            | LLMModel.tenant_id.is_(None),
        ).order_by(LLMModel.label)
    )
    models = result.scalars().all()

    return ModelsResponse(
        models=[
            ModelInfo(
                id=str(m.id),
                provider=m.provider,
                model=m.model,
                label=m.label,
                supports_vision=m.supports_vision,
            )
            for m in models
        ]
    )