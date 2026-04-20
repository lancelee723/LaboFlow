"""Built-in headless Playwright browser for Clawith agents.

Runs one Chromium process per backend process and one BrowserContext per
(agent_id, chat_session_id). See docs/superpowers/specs/2026-04-20-clawith-playwright-browser-design.md
for design rationale.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


# ─── Errors ────────────────────────────────────────────────────────────

class PlaywrightToolError(Exception):
    """Base class for all errors this module raises into tool results."""


class URLBlockedError(PlaywrightToolError):
    """Raised when a URL fails the security gate."""


class RefExpiredError(PlaywrightToolError):
    """Raised when a ref from a prior snapshot is no longer valid."""


class NavigationTimeoutError(PlaywrightToolError):
    """Raised when page load exceeds 30 s."""


class DownloadTimeoutError(PlaywrightToolError):
    """Raised when click+expect_download does not fire within 30 s."""


class DownloadTooLargeError(PlaywrightToolError):
    """Raised when a download exceeds the 100 MB hard cap."""

    def __init__(self, url: str, size_mb: float):
        super().__init__(f"File exceeds 100 MB limit (~{size_mb:.1f} MB)")
        self.url = url
        self.size_mb = size_mb


class DocParseError(PlaywrightToolError):
    """Raised when a document cannot be parsed."""


class PlaywrightCrashError(PlaywrightToolError):
    """Raised when Chromium crashes or the target is unexpectedly closed."""


# ─── URL blocklist ─────────────────────────────────────────────────────

_BLOCKED_SCHEMES = {
    "file", "chrome", "chrome-extension", "devtools",
    "view-source", "javascript",
}

_BLOCKED_HOSTNAMES = {
    "postgres", "redis", "lightrag", "aippt",
    "clawith-backend", "clawith-frontend", "nginx",
}


def _is_private_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
    )


def _resolve_host_ips(hostname: str) -> list[str]:
    """Resolve hostname via getaddrinfo. Returns [] on DNS failure."""
    try:
        infos = socket.getaddrinfo(hostname, None)
        return list({info[4][0] for info in infos})
    except socket.gaierror:
        return []


def _check_url_safe(url: str) -> None:
    """Raise URLBlockedError if the URL fails the security gate.

    Enforced rules:
    * Only http/https/data:image are allowed schemes (plus anything not in the
      explicit blocklist, so relative URLs, mailto, etc. pass — but in practice
      navigate() only ever gets http(s)).
    * Hostname must not be one of the internal Docker service names.
    * Hostname must not be (or resolve to) a private / loopback / link-local IP.
    """
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()

    # data: scheme — only image subtypes are allowed
    if scheme == "data":
        if not parsed.path.startswith("image/"):
            raise URLBlockedError(f"blocked scheme: data:{parsed.path.split(',')[0].split(';')[0]}")
        return

    if scheme in _BLOCKED_SCHEMES:
        raise URLBlockedError(f"blocked scheme: {scheme}")

    host = (parsed.hostname or "").lower()
    if not host:
        return

    if host in _BLOCKED_HOSTNAMES:
        raise URLBlockedError(f"blocked internal service: {host}")

    # Direct IP literal
    if _is_private_ip(host):
        raise URLBlockedError(f"blocked private IP: {host}")

    # DNS resolution — catches rebind & DNS-returned-private-IP attacks
    for ip in _resolve_host_ips(host):
        if _is_private_ip(ip):
            raise URLBlockedError(f"blocked — {host} resolves to private IP {ip}")
