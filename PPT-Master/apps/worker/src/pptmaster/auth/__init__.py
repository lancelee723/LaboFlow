"""Authentication module."""

from .jwt import create_access_token, decode_token
from .middleware import AuthContext, get_auth_context, require_admin, require_creator
from .password import hash_password, verify_password
from .routes import router as auth_router

__all__ = [
    "create_access_token",
    "decode_token",
    "AuthContext",
    "get_auth_context",
    "require_admin",
    "require_creator",
    "hash_password",
    "verify_password",
    "auth_router",
]
