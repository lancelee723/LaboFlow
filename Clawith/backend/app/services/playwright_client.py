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


# ─── Download helpers ──────────────────────────────────────────────────

import os
import uuid
import shutil
from pathlib import Path

from app.config import get_settings

_DOWNLOAD_SIZE_LIMIT_BYTES = 100 * 1024 * 1024  # 100 MB
_DOWNLOAD_TIMEOUT_MS = 30000


def _downloads_root_for_session(agent_id: str, session_id: str) -> Path:
    """Per-session download directory. Created lazily."""
    base = Path(get_settings().AGENT_DATA_DIR)
    path = base / str(agent_id) / "downloads" / str(session_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


# ─── PlaywrightClient ──────────────────────────────────────────────────

import asyncio
from typing import Optional

from loguru import logger

# Note: playwright is imported lazily inside start() so that test collection
# doesn't fail if the package is absent in a dev environment.


class PlaywrightClient:
    """One Chromium process, one BrowserContext per ChatSession.

    Lifecycle:
        c = PlaywrightClient()
        await c.start()           # launches Chromium
        await c.ensure_context()  # lazily creates a BrowserContext
        # ... issue tool calls ...
        await c.close()           # closes context + browser + playwright
    """

    def __init__(self):
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._lock = asyncio.Lock()
        self._ref_registry: dict[str, dict] = {}
        self._ref_counter = 0
        self._agent_id: str | None = None
        self._session_id: str | None = None

    async def start(self) -> None:
        """Launch Chromium. Idempotent."""
        if self._browser is not None and self._browser.is_connected():
            return
        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=["--disable-dev-shm-usage", "--no-sandbox"],
        )
        logger.info("[Playwright] Chromium launched")

    async def ensure_context(self) -> None:
        """Lazily create a BrowserContext with its own cookies/storage."""
        if self._browser is None or not self._browser.is_connected():
            await self.start()
        if self._context is None:
            self._context = await self._browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                ),
            )
            self._page = await self._context.new_page()

    async def close(self) -> None:
        """Close context, browser, and playwright. Safe to call twice."""
        try:
            if self._context is not None:
                await self._context.close()
        except Exception as e:
            logger.warning(f"[Playwright] context.close failed: {e}")
        finally:
            self._context = None
            self._page = None

        try:
            if self._browser is not None:
                await self._browser.close()
        except Exception as e:
            logger.warning(f"[Playwright] browser.close failed: {e}")
        finally:
            self._browser = None

        try:
            if self._playwright is not None:
                await self._playwright.stop()
        except Exception as e:
            logger.warning(f"[Playwright] playwright.stop failed: {e}")
        finally:
            self._playwright = None

    # ─── Accessibility snapshot + ref registry ──────────────────────────

    async def browser_snapshot(self) -> dict:
        """Return an accessibility-tree snapshot of the current page.

        Every interactive node (button, link, textbox, combobox, checkbox,
        etc.) is assigned a short opaque `ref` that stays valid until the
        next snapshot is taken. The LLM uses these refs to address elements.
        """
        await self.ensure_context()
        # Reset ref registry (but keep counter incrementing for uniqueness)
        self._ref_registry = {}

        # Extract DOM tree using JavaScript
        dom_data = await self._page.evaluate(self._get_dom_extraction_script())
        tree_lines: list[str] = []
        self._walk_ax(dom_data, tree_lines, depth=0)
        return {
            "url": self._page.url,
            "title": await self._page.title(),
            "tree": "\n".join(tree_lines),
        }

    def _get_dom_extraction_script(self) -> str:
        """Return JavaScript code to extract DOM tree with roles and labels."""
        return """
        (function() {
            function extractTree(node, maxDepth = 15, depth = 0) {
                if (depth > maxDepth) return null;
                if (node.nodeType !== Node.ELEMENT_NODE) return null;

                const role = node.getAttribute("role") ||
                             (node.tagName === "BUTTON" && "button") ||
                             (node.tagName === "A" && "link") ||
                             (node.tagName === "INPUT" && "textbox") ||
                             (node.tagName === "TEXTAREA" && "textbox") ||
                             (node.tagName === "SELECT" && "combobox") ||
                             (node.tagName === "H1" && "heading") ||
                             (node.tagName === "H2" && "heading") ||
                             (node.tagName === "H3" && "heading") ||
                             (node.tagName === "FORM" && "form") ||
                             null;

                if (!role) {
                    const children = [];
                    for (let child of node.children) {
                        const childData = extractTree(child, maxDepth, depth + 1);
                        if (childData) children.push(childData);
                    }
                    return children.length > 0 ? { children } : null;
                }

                // Get element's accessible name
                let name = node.getAttribute("aria-label") ||
                          node.getAttribute("title") ||
                          node.textContent ||
                          node.getAttribute("placeholder") ||
                          "";
                name = name.trim().substring(0, 80);

                const result = { role, name };

                const children = [];
                for (let child of node.children) {
                    const childData = extractTree(child, maxDepth, depth + 1);
                    if (childData) {
                        if (childData.children && !childData.role) {
                            children.push(...childData.children);
                        } else {
                            children.push(childData);
                        }
                    }
                }
                if (children.length > 0) result.children = children;

                return result;
            }
            return extractTree(document.documentElement);
        })()
        """

    def _walk_ax(self, node: Optional[dict], out: list[str], depth: int) -> None:
        if node is None:
            return

        role = node.get("role", "")
        name = (node.get("name") or "").replace("\n", " ").strip()[:80]
        indent = "  " * depth

        if not role:
            # Intermediate node, process children
            for child in node.get("children", []) or []:
                self._walk_ax(child, out, depth)
            return

        line = f"{indent}- {role}"
        if name:
            line += f' "{name}"'

        # Assign a ref only to interactive roles
        if role in {
            "button", "link", "textbox", "combobox", "checkbox",
            "radio", "menuitem", "tab", "switch", "searchbox", "form",
        }:
            self._ref_counter += 1
            ref_id = f"e{self._ref_counter}"
            # Store selector data — we'll resolve it at action time
            self._ref_registry[ref_id] = {
                "role": role,
                "name": name,
            }
            line += f" [ref={ref_id}]"

        out.append(line)
        for child in node.get("children", []) or []:
            self._walk_ax(child, out, depth + 1)

    def _resolve_ref(self, ref: str) -> dict:
        """Return the selector dict for a ref, or raise RefExpiredError."""
        if ref not in getattr(self, "_ref_registry", {}):
            raise RefExpiredError(
                f"Element ref '{ref}' is stale. Call playwright_browser_snapshot again."
            )
        return self._ref_registry[ref]

    async def _locator_for_ref(self, ref: str):
        """Return a Playwright Locator for a ref entry."""
        entry = self._resolve_ref(ref)
        role = entry["role"]
        name = entry["name"]
        loc = self._page.get_by_role(role, name=name) if name else self._page.get_by_role(role)
        if await loc.count() == 0:
            raise RefExpiredError(
                f"Element ref '{ref}' no longer matches a visible element. "
                "Call playwright_browser_snapshot again."
            )
        return loc.first

    # ─── Navigation ─────────────────────────────────────────────────────

    async def browser_navigate(self, url: str, wait_until: str = "load") -> dict:
        """Navigate to URL. Raises URLBlockedError on gated URLs."""
        _check_url_safe(url)
        await self.ensure_context()
        try:
            await self._page.goto(url, wait_until=wait_until, timeout=30000)
        except Exception as e:
            msg = str(e)
            if "Timeout" in msg or "timeout" in msg:
                raise NavigationTimeoutError(
                    f"Navigation to {url!r} timed out (>30 s). "
                    "Try playwright_browser_screenshot to check state, or retry."
                )
            raise
        return {
            "success": True,
            "url": self._page.url,
            "title": await self._page.title(),
        }

    # ─── Accessibility actions (ref-based) ──────────────────────────────

    async def browser_click(self, ref: str) -> dict:
        loc = await self._locator_for_ref(ref)
        await loc.click(timeout=10000)
        # Page may have navigated; return current state
        return {
            "success": True,
            "url": self._page.url,
            "title": await self._page.title(),
        }

    async def browser_type(self, ref: str, text: str, submit: bool = False) -> dict:
        loc = await self._locator_for_ref(ref)
        await loc.fill(text, timeout=10000)
        if submit:
            await loc.press("Enter")
        return {"success": True, "ref": ref, "chars": len(text), "submit": submit}

    async def browser_select(self, ref: str, values: list[str]) -> dict:
        loc = await self._locator_for_ref(ref)
        await loc.select_option(values, timeout=10000)
        return {"success": True, "ref": ref, "values": values}

    async def browser_hover(self, ref: str) -> dict:
        loc = await self._locator_for_ref(ref)
        await loc.hover(timeout=10000)
        return {"success": True, "ref": ref}

    # ─── Fallback actions (coordinate-based) ────────────────────────────

    async def browser_screenshot(self, full_page: bool = False) -> bytes:
        await self.ensure_context()
        return await self._page.screenshot(full_page=full_page, type="png")

    async def browser_click_xy(self, x: int, y: int) -> dict:
        await self.ensure_context()
        # Try to get href for anchor tags, or fall back to mouse click
        href = await self._page.evaluate(f"""
            () => {{
                const el = document.elementFromPoint({x}, {y});
                if (el && el.tagName === 'A' && el.href) {{
                    return el.href;
                }}
                return null;
            }}
        """)
        if href:
            await self._page.goto(href, timeout=30000, wait_until="load")
        else:
            # Fallback: try dispatching a click event
            await self._page.evaluate(f"""
                () => {{
                    const el = document.elementFromPoint({x}, {y});
                    if (el) {{
                        const evt = new MouseEvent('click', {{
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            clientX: {x},
                            clientY: {y}
                        }});
                        el.dispatchEvent(evt);
                    }}
                }}
            """)
        return {"success": True, "x": x, "y": y}

    async def browser_type_xy(self, x: int, y: int, text: str) -> dict:
        await self.ensure_context()
        await self._page.mouse.click(x, y)
        await self._page.keyboard.type(text, delay=10)
        return {"success": True, "x": x, "y": y, "chars": len(text)}

    # ─── Auxiliary actions ──────────────────────────────────────────────

    async def browser_wait_for(
        self, selector: str = "", text: str = "", timeout_ms: int = 10000
    ) -> dict:
        await self.ensure_context()
        if selector:
            await self._page.wait_for_selector(selector, timeout=timeout_ms)
        elif text:
            await self._page.wait_for_function(
                f"document.body.innerText.includes({text!r})", timeout=timeout_ms
            )
        else:
            await self._page.wait_for_load_state("networkidle", timeout=timeout_ms)
        return {"success": True}

    async def browser_eval(self, expression: str) -> dict:
        """Evaluate a JS expression in the page context.

        No static analysis is performed. See spec §5.3.
        """
        await self.ensure_context()
        value = await self._page.evaluate(expression)
        return {"success": True, "value": value}

    async def browser_get_text(self, ref: str = "") -> dict:
        await self.ensure_context()
        if ref:
            loc = await self._locator_for_ref(ref)
            text = await loc.inner_text(timeout=5000)
        else:
            text = await self._page.inner_text("body", timeout=5000)
        return {"success": True, "text": text}

    async def browser_back(self) -> dict:
        await self.ensure_context()
        await self._page.go_back(timeout=10000)
        return {"success": True, "url": self._page.url}

    async def browser_close_tab(self) -> dict:
        """Close current page and open a fresh one inside the same context."""
        if self._page is not None:
            await self._page.close()
        self._page = await self._context.new_page()
        self._ref_registry = {}
        return {"success": True}

    # ─── Session binding ─────────────────────────────────────────────────

    async def bind_session(self, agent_id: str, session_id: str) -> None:
        """Associate this client with a (agent, session) for download routing."""
        self._agent_id = agent_id
        self._session_id = session_id

    # ─── Downloads ──────────────────────────────────────────────────────

    async def browser_download(self, ref: str, timeout_ms: int = _DOWNLOAD_TIMEOUT_MS) -> dict:
        """Click a ref, wait for a download event, enforce size cap.

        Returns on success:
            {success: True, filename, size, file_id, mime}

        Returns on size cap exceeded:
            {success: False, error, download_url, size_mb}
        """
        await self.ensure_context()
        loc = await self._locator_for_ref(ref)

        try:
            async with self._page.expect_download(timeout=timeout_ms) as dl_info:
                await loc.click()
            download = await dl_info.value
        except Exception as e:
            if "Timeout" in str(e):
                raise DownloadTimeoutError(
                    "No download started within 30 s. The link may open inline."
                )
            raise

        url = download.url
        suggested = download.suggested_filename or f"download-{uuid.uuid4().hex[:8]}.bin"
        target_dir = _downloads_root_for_session(self._agent_id, self._session_id)
        target_path = target_dir / suggested

        await download.save_as(str(target_path))

        size = target_path.stat().st_size
        if size > _DOWNLOAD_SIZE_LIMIT_BYTES:
            try:
                target_path.unlink()
            except OSError:
                pass
            return {
                "success": False,
                "error": "File exceeds 100MB limit",
                "download_url": url,
                "size_mb": size / (1024 * 1024),
            }

        import mimetypes
        mime, _ = mimetypes.guess_type(suggested)
        return {
            "success": True,
            "filename": suggested,
            "size": size,
            "file_id": str(target_path),
            "mime": mime or "application/octet-stream",
        }

    async def browser_list_downloads(self) -> dict:
        """List files in the current session's download dir."""
        target_dir = _downloads_root_for_session(self._agent_id, self._session_id)
        files = []
        for p in sorted(target_dir.iterdir()):
            if p.is_file():
                files.append({
                    "filename": p.name,
                    "size": p.stat().st_size,
                    "file_id": str(p),
                })
        return {"success": True, "files": files}
