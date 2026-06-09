"""User-scoped API routes (profile, locale, storage quota)."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.api._errors import AppError, ErrorCode
from pptmaster.auth.middleware import AuthContext, get_auth_context
from pptmaster.db.models import User
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/users", tags=["users"])


class UpdateMeRequest(BaseModel):
    name: str | None = None
    locale: str | None = None


class MeResponse(BaseModel):
    id: str
    email: str
    name: str | None
    locale: str
    role: str
    is_server_admin: bool


@router.get("/me", response_model=MeResponse)
async def get_me(auth: AuthContext = Depends(get_auth_context)):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.id == auth.user_id))
        user = result.scalar_one_or_none()

        if not user:
            raise AppError(ErrorCode.AUTH_USER_NOT_FOUND, "User not found", status_code=401)

        return MeResponse(
            id=user.id,
            email=user.email,
            name=user.name,
            locale=user.locale,
            role=auth.role,
            is_server_admin=auth.is_server_admin,
        )


@router.patch("/me", response_model=MeResponse)
async def update_me(
    request: UpdateMeRequest,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.id == auth.user_id))
        user = result.scalar_one_or_none()

        if not user:
            raise AppError(ErrorCode.AUTH_USER_NOT_FOUND, "User not found", status_code=401)

        if request.name is not None:
            user.name = request.name
        if request.locale is not None:
            if request.locale not in ("en", "zh"):
                raise AppError(ErrorCode.INVALID_INPUT, "Locale must be 'en' or 'zh'")
            user.locale = request.locale

        await session.commit()

        return MeResponse(
            id=user.id,
            email=user.email,
            name=user.name,
            locale=user.locale,
            role=auth.role,
            is_server_admin=auth.is_server_admin,
        )


@router.get("/me/storage")
async def get_my_storage(auth: AuthContext = Depends(get_auth_context)) -> dict[str, int]:
    """D8: Return storage usage breakdown for the current user."""
    from pptmaster.api._quota import calculate_user_storage_bytes

    return await calculate_user_storage_bytes(auth.user_id)


@router.get("/me/usage")
async def get_my_usage(
    auth: AuthContext = Depends(get_auth_context),
):
    """G4.9: Return token usage for the current user (lifetime + per-project)."""
    from sqlalchemy import func as sa_func

    from pptmaster.db.models import LLMUsage, Project

    async with open_db_session() as session:
        # Lifetime total
        total = (await session.execute(
            select(
                sa_func.sum(LLMUsage.input_tokens).label("in_total"),
                sa_func.sum(LLMUsage.output_tokens).label("out_total"),
            ).where(LLMUsage.user_id == auth.user_id)
        )).one_or_none()

        in_total = int(total.in_total or 0) if total else 0
        out_total = int(total.out_total or 0) if total else 0

        # Per-project breakdown with project name (LEFT JOIN tolerates deleted projects)
        rows = (await session.execute(
            select(
                LLMUsage.project_id,
                Project.name.label("project_name"),
                sa_func.sum(LLMUsage.input_tokens).label("in_sum"),
                sa_func.sum(LLMUsage.output_tokens).label("out_sum"),
                sa_func.max(LLMUsage.created_at).label("last_used"),
            )
            .outerjoin(Project, Project.id == LLMUsage.project_id)
            .where(LLMUsage.user_id == auth.user_id)
            .group_by(LLMUsage.project_id, Project.name)
            .order_by(sa_func.max(LLMUsage.created_at).desc())
        )).all()

        return {
            "lifetime": {
                "tokens_in": in_total,
                "tokens_out": out_total,
                "tokens_total": in_total + out_total,
            },
            "projects": [
                {
                    "project_id": r.project_id,
                    "project_name": r.project_name,
                    "tokens_in": int(r.in_sum),
                    "tokens_out": int(r.out_sum),
                    "tokens_total": int(r.in_sum) + int(r.out_sum),
                    "last_used": r.last_used.isoformat() if r.last_used else None,
                }
                for r in rows
            ],
        }
