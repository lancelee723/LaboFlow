"""SSO entry route — consumes a Clawith JWT and mints a local session cookie."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import RedirectResponse

from pptmaster.auth.jwt import create_access_token
from pptmaster.auth.sso_service import (
    get_or_create_user_by_sso,
    validate_sso_token,
)
from pptmaster.db.session import open_db_session

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sso"])


@router.get("/sso")
async def sso_callback(
    token: str | None = None,
    redirect_url: str = "/projects",
) -> RedirectResponse:
    """Validate Clawith SSO JWT, mirror user, set local cookie, redirect.

    Mounted at /sso. The outer Nginx maps /ppt-master/sso → /sso, so the
    browser-visible URL is /ppt-master/sso?token=<jwt>.
    """
    if not token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing SSO token",
        )

    claims = validate_sso_token(token)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired SSO token",
        )

    clawith_id = claims.get("sub")
    if not clawith_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SSO token missing sub claim",
        )

    async with open_db_session() as session:
        user = await get_or_create_user_by_sso(
            session,
            clawith_id=clawith_id,
            email=claims.get("email"),
            role=claims.get("role", "user"),
        )

    local_token = create_access_token({
        "sub": user.id,
        "email": user.email,
        "role": "admin" if user.is_server_admin else "creator",
        "is_server_admin": user.is_server_admin,
    })

    response = RedirectResponse(url=redirect_url, status_code=302)
    response.set_cookie(
        key="jwt",
        value=local_token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=86400 * 7,
    )
    return response
