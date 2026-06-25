"""
Clawith SSO routes for Pro Slides

Server-rendered SSO flow (differs from WeKnora's SPA approach):
- Clawith redirects to GET /auth/sso?token=JWT
- Backend validates JWT, creates/finds user, creates session, sets cookie
- Redirects to dashboard (or redirect_url if provided)
"""

from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from typing import Optional
from urllib.parse import quote
import logging

from .auth_service import get_auth_service, AuthService
from .sso_service import (
    is_sso_enabled,
    validate_sso_token,
    get_or_create_user_by_sso,
)
from ..database.database import get_db
from ..core.url_utils import prefixed, cookie_path

logger = logging.getLogger(__name__)

router = APIRouter()


def _redirect(path: str) -> RedirectResponse:
    return RedirectResponse(url=prefixed(path), status_code=302)


@router.get("/auth/sso")
@router.get("/sso")
async def sso_callback(
    request: Request,
    token: Optional[str] = None,
    redirect_url: str = "/dashboard",
    db: Session = Depends(get_db),
    auth_service: AuthService = Depends(get_auth_service),
):
    """
    Handle Clawith SSO callback.

    Clawith redirects here with a short-lived HS256 JWT in the `token` query param.
    We validate the JWT, find or create the user, create a session, and redirect.
    """
    logger.info("=== Clawith SSO callback route called ===")

    # Validate token presence
    if not token:
        logger.warning("SSO callback missing token parameter")
        return _redirect("/auth/login?error=SSO令牌缺失")

    # Check if SSO is enabled
    if not is_sso_enabled():
        logger.warning("Clawith SSO not enabled - check config")
        return _redirect("/auth/login?error=Clawith SSO未启用")

    # Validate JWT and extract claims
    claims = validate_sso_token(token)
    if not claims:
        logger.warning("SSO token validation failed")
        return _redirect("/auth/login?error=SSO令牌无效或已过期")

    # Extract required claims
    clawith_id = claims.get("sub")
    email = claims.get("email")

    if not clawith_id:
        logger.warning("SSO token missing sub claim")
        return _redirect("/auth/login?error=SSO令牌缺少用户ID")

    if not email:
        logger.warning("SSO token missing email claim")
        return _redirect("/auth/login?error=SSO令牌缺少邮箱")

    # Optional claims
    name = claims.get("name") or claims.get("display_name")
    avatar_url = claims.get("avatar_url") or claims.get("avatar")

    # Get or create user
    user, created, error_message = get_or_create_user_by_sso(
        db=db,
        clawith_id=clawith_id,
        email=email,
        name=name,
        avatar_url=avatar_url,
    )

    if not user:
        error_encoded = quote(error_message or "用户创建失败")
        return _redirect(f"/auth/login?error={error_encoded}")

    # Check if user is active
    if not user.is_active:
        logger.warning("SSO login for inactive user: %s", user.username)
        return _redirect("/auth/login?error=账户已被禁用")

    # Create session
    session_id = auth_service.create_session(db, user)

    # Build redirect response with session cookie
    response = RedirectResponse(url=prefixed(redirect_url), status_code=302)

    current_expire_minutes = auth_service._get_current_expire_minutes()
    cookie_max_age = None if current_expire_minutes == 0 else current_expire_minutes * 60

    response.set_cookie(
        key="session_id",
        value=session_id,
        max_age=cookie_max_age,
        httponly=True,
        secure=False,
        samesite="lax",
        path=cookie_path(),
    )

    action = "created" if created else "logged in"
    logger.info(
        "User %s %s via Clawith SSO (clawith_id=%s)",
        user.username,
        action,
        clawith_id,
    )
    return response
