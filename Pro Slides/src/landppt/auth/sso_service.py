"""
Clawith SSO service for Pro Slides

Validates HS256 JWT tokens minted by Clawith and finds or creates local users.
Follows the same pattern as WeKnora's SSO login:
  - JWT signed with shared HS256 secret (CLAWITH_SSO_SECRET / PRO_SLIDES_SSO_SECRET)
  - aud claim must match configured audience (default "pro-slides")
  - exp claim required
  - email claim required
  - User lookup: by clawith_id → by email → auto-create
"""

import hashlib
import secrets
import time
import logging
from typing import Optional, Tuple

from jose import JWTError, jwt
from sqlalchemy.orm import Session

from ..database.models import User
from ..core.config import app_config

logger = logging.getLogger(__name__)


def is_sso_enabled() -> bool:
    """Check if Clawith SSO is properly configured and enabled."""
    return bool(app_config.sso_enabled and app_config.sso_jwt_secret)


def validate_sso_token(token: str) -> Optional[dict]:
    """
    Decode and validate an SSO JWT from Clawith.

    Returns the claims dict on success, or None on any validation failure.
    """
    if not app_config.sso_jwt_secret:
        logger.warning("SSO JWT secret not configured")
        return None

    try:
        claims = jwt.decode(
            token,
            app_config.sso_jwt_secret,
            algorithms=[app_config.sso_jwt_algorithm],
            audience=app_config.sso_jwt_audience,
            options={
                "require": ["exp", "aud"],
                "verify_exp": True,
                "verify_aud": True,
            },
        )
        return claims
    except JWTError as e:
        logger.warning("SSO JWT validation failed: %s", e)
        return None


def get_or_create_user_by_sso(
    db: Session,
    clawith_id: str,
    email: Optional[str],
    name: Optional[str] = None,
    avatar_url: Optional[str] = None,
) -> Tuple[Optional[User], bool, Optional[str]]:
    """
    Get existing user or create new user from Clawith SSO.

    Logic (same as get_or_create_user_by_github):
    1. If user with clawith_id exists -> return that user
    2. If email exists and matches a local user -> link clawith_id -> return
    3. Otherwise -> create new user

    Returns (user, created, error_message).
    """
    try:
        # 1. Find by clawith_id
        existing = db.query(User).filter(User.clawith_id == clawith_id).first()
        if existing:
            existing.last_login = time.time()
            if avatar_url:
                existing.avatar = avatar_url
            db.commit()
            return existing, False, None

        # 2. Find by email and link
        if email:
            email_user = db.query(User).filter(User.email == email).first()
            if email_user:
                email_user.clawith_id = clawith_id
                email_user.last_login = time.time()
                if avatar_url and not email_user.avatar:
                    email_user.avatar = avatar_url
                db.commit()
                logger.info(
                    "Linked Clawith SSO (clawith_id=%s) to existing user %s",
                    clawith_id,
                    email_user.username,
                )
                return email_user, False, None

        # 3. Create new user
        # Derive username from name or clawith_id
        base_username = name or f"clawith_{clawith_id}"
        # Strip spaces from name for username
        base_username = base_username.replace(" ", "_")
        username = base_username
        existing_username = db.query(User).filter(User.username == username).first()
        if existing_username:
            username = f"{base_username}_{secrets.token_hex(4)}"

        default_credits = 0
        if app_config.enable_credits_system:
            default_credits = app_config.default_credits_for_new_users

        new_user = User(
            username=username,
            email=email,
            avatar=avatar_url,
            clawith_id=clawith_id,
            oauth_provider="clawith",
            registration_channel="clawith",
            is_active=True,
            is_admin=False,
            credits_balance=default_credits,
            created_at=time.time(),
            last_login=time.time(),
        )
        new_user.password_hash = hashlib.sha256(secrets.token_bytes(32)).hexdigest()

        db.add(new_user)
        db.flush()
        db.commit()
        db.refresh(new_user)

        logger.info(
            "Created new user from Clawith SSO: %s (clawith_id=%s)",
            username,
            clawith_id,
        )
        return new_user, True, None

    except Exception as e:
        logger.error("Failed to get or create user from Clawith SSO: %s", e)
        db.rollback()
        return None, False, "Clawith SSO 登录失败，请稍后重试"
