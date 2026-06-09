"""Authentication middleware for FastAPI."""

from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from pptmaster.auth.jwt import decode_token
from pptmaster.db.models import User
from pptmaster.db.session import open_db_session

security = HTTPBearer(auto_error=False)


@dataclass
class AuthContext:
    user_id: str
    role: Literal["admin", "creator", "viewer"]
    email: str | None
    raw_claims: dict
    is_server_admin: bool = False


PUBLIC_PATHS = {
    "/health",
    "/health/deep",
    "/api/auth/login",
    "/api/auth/accept-invite",
    "/share",
    "/sso",
}


def is_public_path(path: str) -> bool:
    if path in PUBLIC_PATHS:
        return True
    if path.startswith("/share/"):
        return True
    if path.startswith("/api/auth/accept-invite/"):
        return True
    return False


async def get_auth_context(
    request: Request,
    bearer: HTTPAuthorizationCredentials | None = Depends(security),
) -> AuthContext:
    """Extract and validate auth context from request."""

    if is_public_path(request.url.path):
        return AuthContext(user_id="", role="viewer", email=None, raw_claims={})

    token = request.cookies.get("jwt")
    if not token and bearer:
        token = bearer.credentials

    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    claims = decode_token(token)
    if not claims:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user_id = claims.get("sub") or claims.get("user_id")
    email = claims.get("email")

    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token: missing user_id")

    async with open_db_session() as session:
        live_is_server_admin = await ensure_local_mirror(session, user_id, email)

    # Re-derive role from live DB value — JWT role/is_server_admin claims are
    # ignored so that demoted admins lose access on the very next request.
    is_server_admin = live_is_server_admin
    role: Literal["admin", "creator", "viewer"] = "admin" if is_server_admin else "creator"

    return AuthContext(
        user_id=user_id,
        role=role,
        email=email,
        raw_claims=claims,
        is_server_admin=is_server_admin,
    )


async def ensure_local_mirror(
    session,
    user_id: str,
    email: str | None,
) -> bool:
    """Mirror the user row from external auth into local DB.

    Returns the live ``is_server_admin`` value from DB so callers can
    override any stale JWT claim.  DB is the source of truth — role is
    intentionally re-derived from this value on every request so that old
    JWTs cannot grant stale privilege (e.g. after an admin is demoted).
    """
    from sqlalchemy import select

    result = await session.execute(select(User).where(User.id == user_id))
    existing = result.scalar_one_or_none()

    if not existing and email:
        # Stale JWT across DB resets: user_id doesn't match, but email might.
        # Fall back to email lookup to avoid duplicate-key crash on users_email_key.
        result = await session.execute(select(User).where(User.email == email))
        existing = result.scalar_one_or_none()

    if existing:
        # Update the mirror row (external_id may have changed on re-bootstrap)
        if existing.external_id != user_id:
            existing.external_id = user_id
        live_is_server_admin: bool = existing.is_server_admin
    else:
        user = User(
            id=user_id,
            email=email or f"{user_id}@unknown",
            name=None,
            external_id=user_id,
        )
        session.add(user)
        live_is_server_admin = False

    await session.commit()
    return live_is_server_admin


def require_admin(auth: AuthContext = Depends(get_auth_context)) -> AuthContext:
    if auth.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required")
    return auth


def require_creator(auth: AuthContext = Depends(get_auth_context)) -> AuthContext:
    if auth.role not in ("admin", "creator"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Creator required")
    return auth
