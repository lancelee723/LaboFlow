"""Clawith SSO consumer for PPT-Master.

Validates short-lived JWTs minted by Clawith (audience-scoped) and mirrors
the user into the local DB. Mirrors role state on every call so that a
Clawith-side demotion is reflected on the next SSO login.
"""
from __future__ import annotations

import logging
from typing import Any

from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pptmaster.config import get_settings
from pptmaster.db.models import User

logger = logging.getLogger(__name__)


ADMIN_ROLES = {"admin", "platform_admin"}


def validate_sso_token(token: str) -> dict[str, Any] | None:
    """Decode + validate an HS256 JWT minted by Clawith.

    python-jose does not enforce audience presence when the token has no ``aud``
    claim, even with ``options={"require": ["aud"]}``.  We therefore decode
    first (which verifies signature + expiry + audience *value* when present)
    and then manually reject tokens that are missing the ``aud`` claim entirely.
    """
    settings = get_settings()
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.pptmaster_sso_audience,
            options={"require": ["exp"]},
        )
    except JWTError as exc:
        logger.warning("SSO token validation failed: %s", exc)
        return None

    # Manually enforce that the aud claim is present in the token payload.
    if "aud" not in claims:
        logger.warning("SSO token validation failed: missing 'aud' claim")
        return None

    return claims


async def get_or_create_user_by_sso(
    session: AsyncSession,
    *,
    clawith_id: str,
    email: str | None,
    role: str,
) -> User:
    """Find or create a local PPT-Master user from Clawith SSO claims.

    Lookup order:
    1. By external_id == clawith_id.
    2. By email (link this Clawith identity to a pre-existing local user).
    3. Otherwise create a new row.

    is_server_admin is re-derived from role on every call so a Clawith-side
    demotion is mirrored on the very next SSO login.
    """
    desired_admin = role in ADMIN_ROLES

    result = await session.execute(select(User).where(User.external_id == clawith_id))
    user = result.scalar_one_or_none()

    if user is None and email:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if user is not None and user.external_id != clawith_id:
            user.external_id = clawith_id

    if user is None:
        user = User(
            id=clawith_id,
            email=email or f"{clawith_id}@unknown",
            external_id=clawith_id,
            is_server_admin=desired_admin,
        )
        session.add(user)

    if user.is_server_admin != desired_admin:
        user.is_server_admin = desired_admin

    await session.commit()
    await session.refresh(user)
    return user
