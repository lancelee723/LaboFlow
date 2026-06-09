"""Authentication API routes."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import select

from pptmaster.api._errors import AppError, ErrorCode
from pptmaster.auth.jwt import create_access_token
from pptmaster.auth.middleware import AuthContext, get_auth_context
from pptmaster.auth.password import hash_password, verify_password
from pptmaster.db.models import User
from pptmaster.db.session import open_db_session

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/login")
async def login(request: LoginRequest, response: Response):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.email == request.email))
        user = result.scalar_one_or_none()

        if not user or not user.password_hash:
            raise AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid credentials", status_code=401)

        if not verify_password(request.password, user.password_hash):
            raise AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, "Invalid credentials", status_code=401)

        role = "admin" if user.is_server_admin else "creator"

        user.last_login_at = datetime.now(timezone.utc)
        await session.commit()

        token = create_access_token({
            "sub": user.id,
            "role": role,
            "email": user.email,
            "is_server_admin": user.is_server_admin,
        })

        response.set_cookie(
            key="jwt",
            value=token,
            httponly=True,
            secure=False,
            samesite="lax",
            max_age=86400 * 7,
        )

        return {
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.name,
                "role": role,
                "is_server_admin": user.is_server_admin,
                "mustChangePassword": user.must_change_password,
            },
            "must_change_password": user.must_change_password,
        }


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("jwt")
    return {"success": True}


@router.get("/me")
async def get_me(auth: AuthContext = Depends(get_auth_context)):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.id == auth.user_id))
        user = result.scalar_one_or_none()

        if not user:
            raise AppError(ErrorCode.AUTH_USER_NOT_FOUND, "User not found", status_code=401)

        return {
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "locale": user.locale,
            "role": auth.role,
            "is_server_admin": auth.is_server_admin,
            "mustChangePassword": user.must_change_password,
        }


@router.post("/change-password")
async def change_password(
    request: ChangePasswordRequest,
    auth: AuthContext = Depends(get_auth_context),
):
    async with open_db_session() as session:
        result = await session.execute(select(User).where(User.id == auth.user_id))
        user = result.scalar_one_or_none()

        if not user:
            raise AppError(ErrorCode.AUTH_USER_NOT_FOUND, "User not found", status_code=401)

        if not user.password_hash:
            raise AppError(ErrorCode.AUTH_SSO_PASSWORD_NOT_AVAILABLE, "Password change not available for SSO users")

        if not verify_password(request.current_password, user.password_hash):
            raise AppError(ErrorCode.AUTH_WRONG_PASSWORD, "Current password is incorrect")

        user.password_hash = hash_password(request.new_password)
        user.must_change_password = False
        await session.commit()

        return {"success": True}
