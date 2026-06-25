"""
URL path utilities for reverse-proxy / ROOT_PATH handling.

When Pro Slides runs behind nginx at a path prefix (e.g. /ppt), all
server-side absolute paths and Set-Cookie path values need that prefix
or the browser will hit the proxy at the wrong location.

Usage:
    from ..core.url_utils import prefixed, ROOT_PATH

    return RedirectResponse(url=prefixed("/dashboard"))
    response.set_cookie("session_id", ..., path=ROOT_PATH or "/")
"""

import os

ROOT_PATH = os.getenv("ROOT_PATH", "").rstrip("/")


def prefixed(path: str) -> str:
    """Prepend ROOT_PATH to an absolute path. Idempotent."""
    if not path or not path.startswith("/"):
        return path
    if ROOT_PATH and path.startswith(ROOT_PATH + "/"):
        return path
    if ROOT_PATH and path == ROOT_PATH:
        return path
    return f"{ROOT_PATH}{path}"


def cookie_path() -> str:
    """Path value to use for Set-Cookie so cookies are scoped to this app."""
    return ROOT_PATH or "/"
