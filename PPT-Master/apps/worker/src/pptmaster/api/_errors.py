"""Structured API error codes — G4 i18n error-code refactor.

Every user-facing API error uses a machine-readable ErrorCode so the FE can
translate the message into the user's locale.  AppError replaces raw
HTTPException / raise ValueError across all api/*.py and auth/*.py files.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class ErrorCode(str, Enum):
    # Auth
    AUTH_INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS"
    AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED"
    AUTH_USER_NOT_FOUND = "AUTH_USER_NOT_FOUND"
    AUTH_SSO_PASSWORD_NOT_AVAILABLE = "AUTH_SSO_PASSWORD_NOT_AVAILABLE"
    AUTH_WRONG_PASSWORD = "AUTH_WRONG_PASSWORD"

    # Project
    PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND"
    FILE_UNSUPPORTED_TYPE = "FILE_UNSUPPORTED_TYPE"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    PPTX_NOT_FOUND = "PPTX_NOT_FOUND"
    SOURCE_NOT_FOUND = "SOURCE_NOT_FOUND"
    SOURCE_AMBIGUOUS = "SOURCE_AMBIGUOUS"

    # Session
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    SESSION_NOT_RESUMABLE = "SESSION_NOT_RESUMABLE"
    PIPELINE_CANCELLED = "PIPELINE_CANCELLED"

    # LLM
    LLM_NO_PROVIDER = "LLM_NO_PROVIDER"
    LLM_CONFIG_NOT_FOUND = "LLM_CONFIG_NOT_FOUND"

    # Generic
    INVALID_INPUT = "INVALID_INPUT"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"

    # Upstream script errors
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    UPSTREAM_ERROR = "UPSTREAM_ERROR"

    # Concurrency
    CONFLICT = "CONFLICT"


class AppError(Exception):
    """Domain exception that FastAPI serialises to a structured JSON body."""

    def __init__(
        self,
        code: ErrorCode,
        detail: str = "",
        status_code: int = 400,
        params: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.detail = detail
        self.status_code = status_code
        self.params = params or {}


def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    body: dict[str, Any] = {
        "error": {
            "code": exc.code.value,
            "detail": exc.detail,
        },
    }
    if exc.params:
        body["error"]["params"] = exc.params
    return JSONResponse(status_code=exc.status_code, content=body)


def register_error_handler(app: Any) -> None:
    """Register the AppError exception handler on a FastAPI app instance.

    Called from pptmaster/main.py after the app is created.
    """
    app.add_exception_handler(AppError, _app_error_handler)
