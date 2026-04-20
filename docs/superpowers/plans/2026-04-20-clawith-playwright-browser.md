# Clawith Playwright Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in headless Playwright browser and document-parsing toolset to Clawith so Agents can autonomously browse, download files, and read Office/PDF/Markdown documents — all running inside the existing `clawith-backend` container, alongside (not replacing) the AgentBay SaaS browser.

**Architecture:** One Chromium process (launched once per backend process) with one `BrowserContext` per `(agent_id, chat_session_id)` pair, 5-minute idle cleanup. Accessibility-snapshot + ref is the primary interaction path; coordinate-based actions are the fallback. A strict URL blocklist prevents SSRF into internal Docker services. 16 `playwright_browser_*` tools + 2 `doc_*` tools are registered into Clawith's existing `AGENT_TOOLS` list and `execute_tool()` dispatcher.

**Tech Stack:** `playwright>=1.47` (Python async API), `pypdf>=4.0`, `pdfplumber>=0.11`, `python-docx>=1.1`, `openpyxl>=3.1`, `python-pptx>=1.0` (last four already in pyproject.toml). pytest + pytest-asyncio + aiohttp for test fixtures.

**Reference spec:** `docs/superpowers/specs/2026-04-20-clawith-playwright-browser-design.md`

---

## File Structure

**New files:**
- `Clawith/backend/app/services/playwright_client.py` — `PlaywrightClient` class, session cache, blocklist gate, crash-retry wrapper
- `Clawith/backend/app/services/doc_parser.py` — `doc_read()` and `doc_extract_tables()` top-level functions
- `Clawith/backend/tests/conftest.py` — shared fixtures (local HTTP server, temp agent data dir)
- `Clawith/backend/tests/test_playwright_client.py` — unit tests for PlaywrightClient (real Chromium)
- `Clawith/backend/tests/test_doc_tools.py` — unit tests for doc parser
- `Clawith/backend/tests/test_playwright_agent_integration.py` — tool registration + dispatch tests
- `Clawith/backend/tests/fixtures/sample.pdf` — 3-page simple PDF
- `Clawith/backend/tests/fixtures/sample.docx` — simple Word doc
- `Clawith/backend/tests/fixtures/sample.xlsx` — 2-sheet workbook with a table
- `Clawith/backend/tests/fixtures/sample.pptx` — 2-slide deck
- `Clawith/backend/tests/fixtures/sample.md` — multi-line markdown
- `Clawith/backend/tests/fixtures/sample.csv` — 3-column CSV
- `Clawith/backend/tests/fixtures/corrupt.pdf` — intentionally truncated bytes

**Modified files:**
- `Clawith/backend/pyproject.toml` — add `playwright>=1.47`, `pypdf>=4.0`, `aiohttp>=3.9` (test-only)
- `Clawith/backend/Dockerfile` — install Chromium into production image at `PLAYWRIGHT_BROWSERS_PATH`
- `Clawith/backend/app/services/agent_tools.py` — append 18 tool schemas to `AGENT_TOOLS`, add 18 elif branches to `execute_tool()`
- `Clawith/backend/app/main.py` — register `cleanup_playwright_sessions()` as a background task

---

## Task List

- **Task 1:** Add Python dependencies + Dockerfile Chromium install
- **Task 2:** URL blocklist pure function
- **Task 3:** PlaywrightClient skeleton (start / ensure_context / close)
- **Task 4:** Snapshot + ref registry (with RefExpiredError)
- **Task 5:** Navigate (integrates blocklist)
- **Task 6:** Accessibility actions — click / type / select / hover
- **Task 7:** Fallback actions — screenshot / click_xy / type_xy
- **Task 8:** Auxiliary actions — wait_for / eval / get_text / back / close_tab
- **Task 9:** Download + list_downloads (100 MB limit)
- **Task 10:** Session cache + cleanup + Chromium crash retry
- **Task 11:** doc_parser.py — `doc_read`
- **Task 12:** doc_parser.py — `doc_extract_tables`
- **Task 13:** Register 18 tools in `AGENT_TOOLS` and `execute_tool()`
- **Task 14:** Wire cleanup loop in main.py lifespan
- **Task 15:** Integration test — tool schema registry + dispatch
- **Task 16:** Manual acceptance dry run + final commit

---

### Task 1: Add Python dependencies + Dockerfile Chromium install

**Files:**
- Modify: `Clawith/backend/pyproject.toml`
- Modify: `Clawith/backend/Dockerfile`

- [ ] **Step 1: Add runtime deps**

Edit `Clawith/backend/pyproject.toml` — in the `[project]` `dependencies` list, insert two new lines next to the existing `pdfplumber` entry:

```toml
    "pdfplumber>=0.11.0",
    "playwright>=1.47.0",
    "pypdf>=4.0.0",
    "python-docx>=1.1.0",
```

And in `[project.optional-dependencies]` `dev`, append:

```toml
    "aiohttp>=3.9.0",
```

- [ ] **Step 2: Modify Dockerfile to install Chromium in the production stage**

Replace the current `FROM python:3.12-slim AS production` stage block with:

```dockerfile
# ─── Production ─────────────────────────────────────────
FROM python:3.12-slim AS production

WORKDIR /app

# Browsers installed outside $HOME so the non-root 'clawith' user can exec them
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 curl shadowsocks-libev gosu && \
    rm -rf /var/lib/apt/lists/*

# Copy installed packages from deps stage
COPY --from=deps /usr/local/lib/python3.12/site-packages/ /usr/local/lib/python3.12/site-packages/
COPY --from=deps /usr/local/bin/ /usr/local/bin/

# Install Chromium + system libs. `playwright install --with-deps` runs apt under the hood.
RUN mkdir -p /ms-playwright && \
    playwright install --with-deps chromium && \
    chmod -R a+rx /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

# Copy application code
COPY . .

RUN useradd --create-home clawith && \
    mkdir -p /data/agents && \
    chmod +x /app/entrypoint.sh && \
    chown -R clawith:clawith /app /data

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

EXPOSE 8000
ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
```

- [ ] **Step 3: Build the image locally to verify**

Run (from repo root):

```bash
docker build -t clawith-backend-test Clawith/backend
```

Expected: build succeeds, final image size ~1.3 GB (`docker image ls clawith-backend-test`).

- [ ] **Step 4: Smoke-test Chromium launches inside the image**

Run:

```bash
docker run --rm clawith-backend-test python -c "
import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        page = await b.new_page()
        await page.goto('data:text/html,<h1>ok</h1>')
        print(await page.title())
        await b.close()
asyncio.run(main())
"
```

Expected: prints a non-empty title (empty string is acceptable — no exception means Chromium launched). No `executable doesn't exist` errors.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/pyproject.toml Clawith/backend/Dockerfile
git commit -m "chore(clawith): install Playwright + Chromium in backend image"
```

---

### Task 2: URL blocklist pure function

**Files:**
- Create: `Clawith/backend/app/services/playwright_client.py` (new file, partial)
- Test: `Clawith/backend/tests/test_playwright_client.py` (new file, partial)

- [ ] **Step 1: Write the failing tests**

Create `Clawith/backend/tests/test_playwright_client.py` with:

```python
"""Unit tests for PlaywrightClient and its helpers.

Most tests launch a real Chromium — they are marked `playwright` and require
`playwright install chromium` to have been run in the environment.
"""

import pytest

from app.services.playwright_client import (
    URLBlockedError,
    _check_url_safe,
)


class TestURLBlocklist:
    def test_allows_public_https(self):
        _check_url_safe("https://example.com/path?q=1")  # no exception

    def test_blocks_file_scheme(self):
        with pytest.raises(URLBlockedError, match="scheme"):
            _check_url_safe("file:///etc/passwd")

    def test_blocks_chrome_scheme(self):
        with pytest.raises(URLBlockedError, match="scheme"):
            _check_url_safe("chrome://settings")

    def test_blocks_javascript_scheme(self):
        with pytest.raises(URLBlockedError, match="scheme"):
            _check_url_safe("javascript:alert(1)")

    def test_blocks_data_text_html(self):
        with pytest.raises(URLBlockedError, match="scheme"):
            _check_url_safe("data:text/html,<h1>x</h1>")

    def test_allows_data_image(self):
        _check_url_safe("data:image/png;base64,iVBORw0KG")  # no exception

    def test_blocks_loopback_ipv4(self):
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://127.0.0.1:9621")

    def test_blocks_loopback_ipv6(self):
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://[::1]/")

    def test_blocks_private_10(self):
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://10.0.0.1/")

    def test_blocks_private_172_16(self):
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://172.20.1.1/")

    def test_blocks_private_192_168(self):
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://192.168.0.100/")

    def test_blocks_link_local(self):
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://169.254.169.254/")

    def test_blocks_docker_hostname_postgres(self):
        with pytest.raises(URLBlockedError, match="internal"):
            _check_url_safe("http://postgres:5432/")

    def test_blocks_docker_hostname_lightrag(self):
        with pytest.raises(URLBlockedError, match="internal"):
            _check_url_safe("http://lightrag:9621/")

    def test_blocks_dns_rebind(self, monkeypatch):
        # Simulate a public hostname that resolves to a private IP
        import socket

        def fake_getaddrinfo(host, *args, **kwargs):
            if host == "rebind.example":
                return [(socket.AF_INET, None, None, "", ("10.0.0.5", 0))]
            raise socket.gaierror

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
        with pytest.raises(URLBlockedError, match="private"):
            _check_url_safe("http://rebind.example/")
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py -v
```

Expected: all tests in `TestURLBlocklist` FAIL with `ModuleNotFoundError: No module named 'app.services.playwright_client'`.

- [ ] **Step 3: Implement URL blocklist**

Create `Clawith/backend/app/services/playwright_client.py` with:

```python
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
            raise URLBlockedError(f"blocked scheme: data:{parsed.path.split(';')[0]}")
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestURLBlocklist -v
```

Expected: all 14 tests in `TestURLBlocklist` PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add URL blocklist gate for Playwright browser"
```

---

### Task 3: PlaywrightClient skeleton (start / ensure_context / close)

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`
- Create: `Clawith/backend/tests/conftest.py`

- [ ] **Step 1: Create shared pytest fixtures**

Create `Clawith/backend/tests/conftest.py`:

```python
"""Shared pytest fixtures."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
import pytest_asyncio
from aiohttp import web


@pytest_asyncio.fixture
async def local_http_server(tmp_path: Path):
    """Tiny local HTTP server serving fixture pages.

    Routes:
        GET /             → <h1>Hello</h1>
        GET /form         → form with username/password inputs
        GET /next         → landing after form submit
        GET /download/<n> → generates <n>-byte plaintext response with
                            Content-Disposition: attachment
    """

    async def index(request):
        return web.Response(
            text="<html><head><title>Index</title></head>"
            "<body><h1>Hello</h1><a id='go' href='/next'>Next</a></body></html>",
            content_type="text/html",
        )

    async def form_page(request):
        return web.Response(
            text="<html><body>"
            "<form action='/next' method='get'>"
            "<input name='username' id='u'>"
            "<input name='password' type='password' id='p'>"
            "<button type='submit' id='s'>Submit</button>"
            "</form></body></html>",
            content_type="text/html",
        )

    async def next_page(request):
        return web.Response(text="<h1>Landed</h1>", content_type="text/html")

    async def download(request):
        n = int(request.match_info["n"])
        body = b"x" * n
        return web.Response(
            body=body,
            content_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="dl.bin"'},
        )

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/form", form_page)
    app.router.add_get("/next", next_page)
    app.router.add_get("/download/{n:\\d+}", download)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()

    port = site._server.sockets[0].getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    # NOTE: 127.0.0.1 is on the blocklist; tests bypass the gate or use an
    # injected hostname override. See the `_bypass_url_check` fixture below.

    try:
        yield base_url
    finally:
        await runner.cleanup()


@pytest.fixture
def bypass_url_check(monkeypatch):
    """Replace _check_url_safe with a no-op so tests can use 127.0.0.1."""
    from app.services import playwright_client
    monkeypatch.setattr(playwright_client, "_check_url_safe", lambda url: None)
```

- [ ] **Step 2: Write failing tests for PlaywrightClient lifecycle**

Append to `Clawith/backend/tests/test_playwright_client.py`:

```python
# ─── Lifecycle tests (real Chromium) ────────────────────────────────────

import pytest_asyncio

from app.services.playwright_client import PlaywrightClient


@pytest_asyncio.fixture
async def client():
    c = PlaywrightClient()
    await c.start()
    try:
        yield c
    finally:
        await c.close()


class TestLifecycle:
    @pytest.mark.asyncio
    async def test_start_creates_browser(self, client):
        assert client._browser is not None
        assert client._browser.is_connected()

    @pytest.mark.asyncio
    async def test_ensure_context_creates_context(self, client):
        await client.ensure_context()
        assert client._context is not None

    @pytest.mark.asyncio
    async def test_ensure_context_is_idempotent(self, client):
        await client.ensure_context()
        first = client._context
        await client.ensure_context()
        assert client._context is first

    @pytest.mark.asyncio
    async def test_close_is_idempotent(self, client):
        await client.close()
        await client.close()  # second call must not raise
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestLifecycle -v
```

Expected: tests FAIL with `AttributeError: module 'app.services.playwright_client' has no attribute 'PlaywrightClient'`.

- [ ] **Step 4: Implement lifecycle**

Append to `Clawith/backend/app/services/playwright_client.py`:

```python
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
        self._lock = asyncio.Lock()  # serializes tool calls on this client

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
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestLifecycle -v
```

Expected: all 4 `TestLifecycle` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py Clawith/backend/tests/conftest.py
git commit -m "feat(clawith): add PlaywrightClient lifecycle skeleton"
```

---

### Task 4: Snapshot + ref registry

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_playwright_client.py`:

```python
class TestSnapshot:
    @pytest.mark.asyncio
    async def test_snapshot_returns_refs(self, client, local_http_server, bypass_url_check):
        await client.ensure_context()
        await client._page.goto(f"{local_http_server}/")
        snap = await client.browser_snapshot()
        assert "url" in snap
        assert "tree" in snap
        # Each interactive element gets a `[ref=...]` tag in the YAML-ish tree
        assert "[ref=" in snap["tree"]
        # The anchor tag from the fixture page must be present
        assert "Next" in snap["tree"] or "link" in snap["tree"].lower()

    @pytest.mark.asyncio
    async def test_ref_expired_after_new_snapshot_and_dom_change(self, client, local_http_server, bypass_url_check):
        from app.services.playwright_client import RefExpiredError

        await client.ensure_context()
        await client._page.goto(f"{local_http_server}/")
        snap1 = await client.browser_snapshot()
        # Grab the first ref from the tree
        import re
        refs = re.findall(r"\[ref=(\w+)\]", snap1["tree"])
        assert refs, "no refs in snapshot"
        stale_ref = refs[0]

        # Navigate elsewhere and take a new snapshot — the old ref is stale
        await client._page.goto(f"{local_http_server}/form")
        await client.browser_snapshot()
        with pytest.raises(RefExpiredError):
            client._resolve_ref(stale_ref)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestSnapshot -v
```

Expected: FAIL — `browser_snapshot` attribute missing.

- [ ] **Step 3: Implement snapshot + ref registry**

Append to `PlaywrightClient` in `playwright_client.py` (place inside the class, after `close`):

```python
    # ─── Accessibility snapshot + ref registry ──────────────────────────

    async def browser_snapshot(self) -> dict:
        """Return an accessibility-tree YAML-ish snapshot of the current page.

        Every interactive node (button, link, textbox, combobox, checkbox,
        etc.) is assigned a short opaque `ref` that stays valid until the
        next snapshot is taken. The LLM uses these refs to address elements.
        """
        await self.ensure_context()
        # Reset ref registry — refs from prior snapshots are now stale
        self._ref_registry = {}
        self._ref_counter = 0

        snapshot = await self._page.accessibility.snapshot(interesting_only=True)
        tree_lines: list[str] = []
        self._walk_ax(snapshot, tree_lines, depth=0)
        return {
            "url": self._page.url,
            "title": await self._page.title(),
            "tree": "\n".join(tree_lines),
        }

    def _walk_ax(self, node: Optional[dict], out: list[str], depth: int) -> None:
        if node is None:
            return
        role = node.get("role", "")
        name = (node.get("name") or "").replace("\n", " ").strip()[:80]
        indent = "  " * depth
        line = f"{indent}- {role}"
        if name:
            line += f' "{name}"'
        # Assign a ref only to interactive roles
        if role in {
            "button", "link", "textbox", "combobox", "checkbox",
            "radio", "menuitem", "tab", "switch", "searchbox",
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
```

And in `__init__` add the two registry attributes (modify the existing `__init__`):

```python
    def __init__(self):
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._lock = asyncio.Lock()
        self._ref_registry: dict[str, dict] = {}
        self._ref_counter = 0
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestSnapshot -v
```

Expected: both snapshot tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add accessibility snapshot and ref registry"
```

---

### Task 5: Navigate (integrates blocklist)

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_playwright_client.py`:

```python
class TestNavigate:
    @pytest.mark.asyncio
    async def test_navigate_public_url(self, client, local_http_server, bypass_url_check):
        result = await client.browser_navigate(f"{local_http_server}/")
        assert result["success"] is True
        assert result["url"].endswith("/")
        assert result["title"] == "Index"

    @pytest.mark.asyncio
    async def test_navigate_blocked_scheme_raises(self, client):
        from app.services.playwright_client import URLBlockedError
        with pytest.raises(URLBlockedError):
            await client.browser_navigate("file:///etc/passwd")

    @pytest.mark.asyncio
    async def test_navigate_blocked_internal_raises(self, client):
        from app.services.playwright_client import URLBlockedError
        with pytest.raises(URLBlockedError):
            await client.browser_navigate("http://postgres:5432/")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestNavigate -v
```

Expected: FAIL — `browser_navigate` missing.

- [ ] **Step 3: Implement navigate**

Append inside `PlaywrightClient`:

```python
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
```

- [ ] **Step 4: Run tests**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestNavigate -v
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add browser_navigate with blocklist gate"
```

---

### Task 6: Accessibility actions — click / type / select / hover

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
class TestAccessibilityActions:
    @pytest.mark.asyncio
    async def test_click_by_ref_navigates(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        snap = await client.browser_snapshot()
        import re
        # Find the ref for the "Next" link
        link_refs = [m.group(1) for m in re.finditer(r'link "Next"\s*\[ref=(\w+)\]', snap["tree"])]
        assert link_refs, f"Next link not found in tree:\n{snap['tree']}"
        result = await client.browser_click(link_refs[0])
        assert result["success"] is True
        assert result["url"].endswith("/next")

    @pytest.mark.asyncio
    async def test_type_fills_input(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/form")
        snap = await client.browser_snapshot()
        import re
        # The username textbox
        tb_refs = [m.group(1) for m in re.finditer(r'(?:textbox|searchbox)[^\[]*\[ref=(\w+)\]', snap["tree"])]
        assert tb_refs, f"textbox not found:\n{snap['tree']}"
        await client.browser_type(tb_refs[0], "alice")
        # Verify the value landed in the DOM
        value = await client._page.eval_on_selector("#u", "el => el.value")
        assert value == "alice"

    @pytest.mark.asyncio
    async def test_hover_on_ref_does_not_raise(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        snap = await client.browser_snapshot()
        import re
        refs = re.findall(r"\[ref=(\w+)\]", snap["tree"])
        assert refs
        result = await client.browser_hover(refs[0])
        assert result["success"] is True
```

- [ ] **Step 2: Run tests**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestAccessibilityActions -v
```

Expected: FAIL — methods missing.

- [ ] **Step 3: Implement actions**

Append inside `PlaywrightClient`:

```python
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
```

- [ ] **Step 4: Run tests**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestAccessibilityActions -v
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add ref-based click/type/select/hover actions"
```

---

### Task 7: Fallback actions — screenshot / click_xy / type_xy

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Write failing tests**

```python
class TestFallbackActions:
    @pytest.mark.asyncio
    async def test_screenshot_returns_png_bytes(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        png = await client.browser_screenshot()
        assert isinstance(png, bytes)
        # PNG magic header
        assert png[:8] == b"\x89PNG\r\n\x1a\n"

    @pytest.mark.asyncio
    async def test_click_xy_fires_at_coords(self, client, local_http_server, bypass_url_check):
        # Navigate to a page with a link and click its approximate coords
        await client.browser_navigate(f"{local_http_server}/")
        # The "Next" link is near top-left, click at (50,50) and expect navigation
        box = await client._page.locator("#go").bounding_box()
        assert box
        x, y = int(box["x"] + box["width"] / 2), int(box["y"] + box["height"] / 2)
        await client.browser_click_xy(x, y)
        # Give navigation a moment
        await client._page.wait_for_load_state("load", timeout=5000)
        assert client._page.url.endswith("/next")

    @pytest.mark.asyncio
    async def test_type_xy_fills_focused_input(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/form")
        box = await client._page.locator("#u").bounding_box()
        assert box
        x, y = int(box["x"] + 5), int(box["y"] + box["height"] / 2)
        await client.browser_type_xy(x, y, "bob")
        value = await client._page.eval_on_selector("#u", "el => el.value")
        assert value == "bob"
```

- [ ] **Step 2: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestFallbackActions -v
```

Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

Append inside class:

```python
    # ─── Fallback actions (coordinate-based) ────────────────────────────

    async def browser_screenshot(self, full_page: bool = False) -> bytes:
        await self.ensure_context()
        return await self._page.screenshot(full_page=full_page, type="png")

    async def browser_click_xy(self, x: int, y: int) -> dict:
        await self.ensure_context()
        await self._page.mouse.click(x, y)
        return {"success": True, "x": x, "y": y}

    async def browser_type_xy(self, x: int, y: int, text: str) -> dict:
        await self.ensure_context()
        await self._page.mouse.click(x, y)
        await self._page.keyboard.type(text, delay=10)
        return {"success": True, "x": x, "y": y, "chars": len(text)}
```

- [ ] **Step 4: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestFallbackActions -v
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add coordinate-based fallback browser actions"
```

---

### Task 8: Auxiliary actions — wait_for / eval / get_text / back / close_tab

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Write failing tests**

```python
class TestAux:
    @pytest.mark.asyncio
    async def test_wait_for_selector(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        res = await client.browser_wait_for(selector="h1", timeout_ms=5000)
        assert res["success"] is True

    @pytest.mark.asyncio
    async def test_eval_returns_result(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        res = await client.browser_eval("2 + 2")
        assert res["value"] == 4

    @pytest.mark.asyncio
    async def test_get_text_full_page(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        res = await client.browser_get_text()
        assert "Hello" in res["text"]

    @pytest.mark.asyncio
    async def test_back_returns_to_previous(self, client, local_http_server, bypass_url_check):
        await client.browser_navigate(f"{local_http_server}/")
        await client.browser_navigate(f"{local_http_server}/form")
        res = await client.browser_back()
        assert res["success"] is True
        assert client._page.url.endswith("/")
```

- [ ] **Step 2: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestAux -v
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Append inside class:

```python
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
        self._ref_counter = 0
        return {"success": True}
```

- [ ] **Step 4: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestAux -v
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add wait_for/eval/get_text/back/close_tab actions"
```

---

### Task 9: Download + list_downloads (100 MB limit)

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Extend fixture server with a large-file route**

Edit `Clawith/backend/tests/conftest.py` `local_http_server` fixture — replace the `download` handler with:

```python
    async def download(request):
        n = int(request.match_info["n"])
        body = b"x" * n
        return web.Response(
            body=body,
            content_type="application/octet-stream",
            headers={
                "Content-Disposition": 'attachment; filename="dl.bin"',
                "Content-Length": str(n),
            },
        )
```

(Content-Length is needed so the Content-Length-based size check can trip.)

- [ ] **Step 2: Write failing tests**

```python
class TestDownload:
    @pytest.mark.asyncio
    async def test_download_under_limit(
        self, client, local_http_server, bypass_url_check, tmp_path, monkeypatch
    ):
        # Point downloads dir at a tmp path
        monkeypatch.setattr(
            "app.services.playwright_client._downloads_root_for_session",
            lambda agent_id, session_id: tmp_path,
        )
        await client.bind_session(agent_id="a-1", session_id="s-1")
        await client.browser_navigate(f"{local_http_server}/")
        # Inject a link we can click that triggers a download
        await client._page.set_content(
            f'<a id="dl" href="{local_http_server}/download/1024" download>dl</a>'
        )
        snap = await client.browser_snapshot()
        import re
        refs = re.findall(r"\[ref=(\w+)\]", snap["tree"])
        assert refs
        result = await client.browser_download(refs[0])
        assert result["success"] is True
        assert result["size"] == 1024
        assert (tmp_path / result["filename"]).exists()

    @pytest.mark.asyncio
    async def test_download_over_limit(
        self, client, local_http_server, bypass_url_check, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(
            "app.services.playwright_client._downloads_root_for_session",
            lambda agent_id, session_id: tmp_path,
        )
        await client.bind_session(agent_id="a-1", session_id="s-2")
        await client.browser_navigate(f"{local_http_server}/")
        huge = 150 * 1024 * 1024  # 150 MB advertised
        await client._page.set_content(
            f'<a id="dl" href="{local_http_server}/download/{huge}" download>dl</a>'
        )
        snap = await client.browser_snapshot()
        import re
        refs = re.findall(r"\[ref=(\w+)\]", snap["tree"])
        result = await client.browser_download(refs[0])
        assert result["success"] is False
        assert result["size_mb"] > 100
        assert result["download_url"].endswith(f"/download/{huge}")

    @pytest.mark.asyncio
    async def test_list_downloads(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "app.services.playwright_client._downloads_root_for_session",
            lambda agent_id, session_id: tmp_path,
        )
        await client.bind_session(agent_id="a-1", session_id="s-3")
        (tmp_path / "a.txt").write_text("x")
        (tmp_path / "b.pdf").write_bytes(b"%PDF-")
        res = await client.browser_list_downloads()
        names = sorted(f["filename"] for f in res["files"])
        assert names == ["a.txt", "b.pdf"]
```

- [ ] **Step 3: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestDownload -v
```

Expected: FAIL — `bind_session`, `browser_download`, `browser_list_downloads`, and `_downloads_root_for_session` missing.

- [ ] **Step 4: Implement download path**

Add to module-level in `playwright_client.py` (above the class):

```python
import os
import uuid
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
```

And inside `PlaywrightClient`:

```python
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

        # Pre-check via Content-Length if available on the response
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
            "file_id": str(target_path),  # absolute path is the file_id
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
```

And update `__init__` to add the session attributes:

```python
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
```

- [ ] **Step 5: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestDownload -v
```

Expected: all 3 tests PASS. (The `test_download_over_limit` test saves 150 MB to a tmpdir then deletes it — this is acceptable since pytest's tmp_path is cleaned up. If CI disk is tight, reduce the size to 101 MB.)

- [ ] **Step 6: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py Clawith/backend/tests/conftest.py
git commit -m "feat(clawith): add browser_download with 100MB cap and list_downloads"
```

---

### Task 10: Session cache + cleanup + Chromium crash retry

**Files:**
- Modify: `Clawith/backend/app/services/playwright_client.py`
- Modify: `Clawith/backend/tests/test_playwright_client.py`

- [ ] **Step 1: Write failing tests**

```python
class TestSessionCache:
    @pytest.mark.asyncio
    async def test_get_client_returns_same_instance_for_same_key(self):
        from app.services.playwright_client import (
            get_playwright_client_for_session,
            _playwright_sessions,
        )
        _playwright_sessions.clear()
        c1 = await get_playwright_client_for_session("a", "s1")
        c2 = await get_playwright_client_for_session("a", "s1")
        assert c1 is c2
        await c1.close()
        _playwright_sessions.clear()

    @pytest.mark.asyncio
    async def test_get_client_isolates_different_sessions(self):
        from app.services.playwright_client import (
            get_playwright_client_for_session,
            _playwright_sessions,
        )
        _playwright_sessions.clear()
        c1 = await get_playwright_client_for_session("a", "s1")
        c2 = await get_playwright_client_for_session("a", "s2")
        assert c1 is not c2
        await c1.close()
        await c2.close()
        _playwright_sessions.clear()

    @pytest.mark.asyncio
    async def test_cleanup_removes_idle_sessions(self):
        from datetime import datetime, timedelta
        from app.services.playwright_client import (
            get_playwright_client_for_session,
            cleanup_playwright_sessions,
            _playwright_sessions,
        )
        _playwright_sessions.clear()
        client = await get_playwright_client_for_session("a", "s-old")
        # Force last_used to 10 min ago
        key = ("a", "s-old")
        old = datetime.now() - timedelta(minutes=10)
        _playwright_sessions[key] = (client, old)
        await cleanup_playwright_sessions()
        assert key not in _playwright_sessions

    @pytest.mark.asyncio
    async def test_crash_retry_recovers(self, local_http_server, bypass_url_check):
        """If the browser is closed underneath us, the wrapped call recreates it."""
        from app.services.playwright_client import get_playwright_client_for_session, _playwright_sessions
        _playwright_sessions.clear()
        client = await get_playwright_client_for_session("a", "s-crash")
        await client.browser_navigate(f"{local_http_server}/")
        # Simulate crash
        await client._browser.close()
        assert not client._browser.is_connected()
        # Next call should auto-recover
        result = await client.browser_navigate(f"{local_http_server}/form")
        assert result["success"] is True
        await client.close()
        _playwright_sessions.clear()
```

- [ ] **Step 2: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestSessionCache -v
```

Expected: FAIL — `get_playwright_client_for_session` / `cleanup_playwright_sessions` missing.

- [ ] **Step 3: Implement cache + cleanup + retry**

Append at module level in `playwright_client.py`:

```python
# ─── Session cache ──────────────────────────────────────────────────────

from datetime import datetime, timedelta
import shutil

_PLAYWRIGHT_SESSION_TIMEOUT = timedelta(minutes=5)
_playwright_sessions: dict[tuple[str, str], tuple["PlaywrightClient", datetime]] = {}


async def get_playwright_client_for_session(
    agent_id: str, session_id: str
) -> "PlaywrightClient":
    """Get-or-create a PlaywrightClient bound to (agent_id, session_id)."""
    key = (str(agent_id), str(session_id))
    now = datetime.now()

    if key in _playwright_sessions:
        client, _ = _playwright_sessions[key]
        # Health check — if browser died, drop and recreate
        if client._browser is not None and client._browser.is_connected():
            _playwright_sessions[key] = (client, now)
            return client
        else:
            logger.warning(f"[Playwright] Browser for {key} disconnected, recreating")
            try:
                await client.close()
            except Exception:
                pass
            del _playwright_sessions[key]

    client = PlaywrightClient()
    await client.start()
    await client.bind_session(agent_id=str(agent_id), session_id=str(session_id))
    _playwright_sessions[key] = (client, now)
    return client


async def cleanup_playwright_sessions() -> None:
    """Close any client idle longer than _PLAYWRIGHT_SESSION_TIMEOUT."""
    now = datetime.now()
    expired = [
        k for k, (_, last_used) in _playwright_sessions.items()
        if now - last_used > _PLAYWRIGHT_SESSION_TIMEOUT
    ]
    for k in expired:
        client, _ = _playwright_sessions.pop(k)
        agent_id, session_id = k
        try:
            await client.close()
        except Exception as e:
            logger.warning(f"[Playwright] close during cleanup failed: {e}")
        # Wipe download dir
        try:
            download_dir = _downloads_root_for_session(agent_id, session_id)
            if download_dir.exists():
                shutil.rmtree(download_dir, ignore_errors=True)
        except Exception as e:
            logger.warning(f"[Playwright] download cleanup failed: {e}")
        logger.info(f"[Playwright] Cleaned up session {k}")
```

Now wrap every public browser_* method with a crash-retry decorator. Add this decorator near the top of the class (after imports):

```python
def _with_crash_retry(fn):
    """Wrap a PlaywrightClient method so one-shot Chromium crashes auto-recover."""
    async def wrapper(self, *args, **kwargs):
        async with self._lock:  # serialize tool calls per client
            try:
                return await fn(self, *args, **kwargs)
            except Exception as e:
                msg = str(e)
                crash_markers = (
                    "Target page, context or browser has been closed",
                    "Browser has been closed",
                    "Target closed",
                    "TargetClosedError",
                )
                if not any(m in msg for m in crash_markers):
                    raise
                logger.warning(f"[Playwright] Chromium crash detected in {fn.__name__}, retrying once")
                # Rebuild browser + context from scratch
                await self.close()
                await self.start()
                await self.ensure_context()
                try:
                    return await fn(self, *args, **kwargs)
                except Exception as retry_err:
                    raise PlaywrightCrashError(
                        f"Browser crashed during {fn.__name__}, recovery failed: {retry_err}"
                    )
    wrapper.__name__ = fn.__name__
    return wrapper
```

Apply `@_with_crash_retry` to every public browser_* method in the class: `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_type`, `browser_select`, `browser_hover`, `browser_screenshot`, `browser_click_xy`, `browser_type_xy`, `browser_wait_for`, `browser_eval`, `browser_get_text`, `browser_back`, `browser_close_tab`, `browser_download`, `browser_list_downloads`.

Example:

```python
    @_with_crash_retry
    async def browser_snapshot(self) -> dict:
        ...
```

- [ ] **Step 4: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py::TestSessionCache -v
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Run the full PlaywrightClient test file**

```bash
cd Clawith/backend && pytest tests/test_playwright_client.py -v
```

Expected: all tests PASS (this catches decorators that broke earlier tests).

- [ ] **Step 6: Commit**

```bash
git add Clawith/backend/app/services/playwright_client.py Clawith/backend/tests/test_playwright_client.py
git commit -m "feat(clawith): add Playwright session cache, cleanup, crash retry"
```

---

### Task 11: doc_parser.py — `doc_read`

**Files:**
- Create: `Clawith/backend/app/services/doc_parser.py`
- Create: `Clawith/backend/tests/test_doc_tools.py`
- Create: `Clawith/backend/tests/fixtures/sample.md`
- Create: `Clawith/backend/tests/fixtures/sample.csv`
- Create: `Clawith/backend/tests/fixtures/sample.pdf`
- Create: `Clawith/backend/tests/fixtures/sample.docx`
- Create: `Clawith/backend/tests/fixtures/sample.xlsx`
- Create: `Clawith/backend/tests/fixtures/sample.pptx`
- Create: `Clawith/backend/tests/fixtures/corrupt.pdf`

- [ ] **Step 1: Generate test fixtures**

Run this one-off script (save to a temp file or run inline with `python -c`):

```bash
cd Clawith/backend/tests && mkdir -p fixtures && python - <<'PYEOF'
from pathlib import Path
fix = Path("fixtures")

# Markdown
(fix / "sample.md").write_text(
    "# Title\n\nThis is a paragraph.\n\n- bullet 1\n- bullet 2\n",
    encoding="utf-8",
)

# CSV
(fix / "sample.csv").write_text(
    "name,age,city\nalice,30,NYC\nbob,25,LA\n",
    encoding="utf-8",
)

# Corrupt PDF — just a truncated PDF header
(fix / "corrupt.pdf").write_bytes(b"%PDF-1.4 corrupt bytes here")

# Simple PDF via pypdf
from pypdf import PdfWriter
from io import BytesIO
w = PdfWriter()
# pypdf cannot author content from scratch easily; fall back to reportlab if available
try:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import LETTER
    buf = BytesIO()
    c = canvas.Canvas(str(fix / "sample.pdf"), pagesize=LETTER)
    c.drawString(100, 750, "Page one — hello world")
    c.showPage()
    c.drawString(100, 750, "Page two — second page content")
    c.showPage()
    c.drawString(100, 750, "Page three — third page content")
    c.save()
except ImportError:
    # Minimal valid PDF if reportlab not installed
    (fix / "sample.pdf").write_bytes(
        b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n"
        b"trailer<</Root 1 0 R/Size 4>>\n%%EOF\n"
    )

# DOCX
from docx import Document
doc = Document()
doc.add_heading("Sample Doc", level=1)
doc.add_paragraph("Hello docx world.")
doc.save(str(fix / "sample.docx"))

# XLSX
from openpyxl import Workbook
wb = Workbook()
ws1 = wb.active
ws1.title = "Sheet1"
ws1.append(["A", "B", "C"])
ws1.append([1, 2, 3])
ws1.append([4, 5, 6])
ws2 = wb.create_sheet("Sheet2")
ws2.append(["x", "y"])
ws2.append([10, 20])
wb.save(str(fix / "sample.xlsx"))

# PPTX
from pptx import Presentation
prs = Presentation()
slide1 = prs.slides.add_slide(prs.slide_layouts[1])
slide1.shapes.title.text = "Slide One Title"
slide1.placeholders[1].text = "Slide one body text"
slide2 = prs.slides.add_slide(prs.slide_layouts[1])
slide2.shapes.title.text = "Slide Two Title"
slide2.placeholders[1].text = "Second slide body"
prs.save(str(fix / "sample.pptx"))

print("fixtures written")
PYEOF
```

Note: if `reportlab` isn't installed, add `reportlab` to your dev deps temporarily for this step; after fixtures are committed you can remove it. Alternatively write a precomputed small PDF byte stream — reportlab is only needed once.

- [ ] **Step 2: Write failing tests**

Create `Clawith/backend/tests/test_doc_tools.py`:

```python
"""Unit tests for app.services.doc_parser."""

from pathlib import Path

import pytest

from app.services.doc_parser import doc_read, DocParseError


FIX = Path(__file__).parent / "fixtures"


class TestDocRead:
    def test_md(self):
        res = doc_read(str(FIX / "sample.md"))
        assert res["format"] == "md"
        assert "Title" in res["text"]
        assert "bullet 1" in res["text"]

    def test_csv(self):
        res = doc_read(str(FIX / "sample.csv"))
        assert res["format"] == "csv"
        assert "alice" in res["text"]

    def test_pdf(self):
        res = doc_read(str(FIX / "sample.pdf"))
        assert res["format"] == "pdf"
        # With reportlab-generated PDF, "hello world" is present
        assert res["page_count"] >= 1

    def test_docx(self):
        res = doc_read(str(FIX / "sample.docx"))
        assert res["format"] == "docx"
        assert "docx world" in res["text"]

    def test_xlsx(self):
        res = doc_read(str(FIX / "sample.xlsx"))
        assert res["format"] == "xlsx"
        # Both sheets should be represented
        assert "Sheet1" in res["text"]
        assert "Sheet2" in res["text"]

    def test_pptx(self):
        res = doc_read(str(FIX / "sample.pptx"))
        assert res["format"] == "pptx"
        assert "Slide One Title" in res["text"]
        assert "Slide Two Title" in res["text"]

    def test_truncation(self):
        res = doc_read(str(FIX / "sample.md"), max_chars=10)
        assert res["truncated"] is True
        assert len(res["text"]) == 10

    def test_page_range_pdf(self):
        res_full = doc_read(str(FIX / "sample.pdf"))
        res_first = doc_read(str(FIX / "sample.pdf"), page_range="1")
        # The first-page-only text should be shorter than or equal to the full
        assert len(res_first["text"]) <= len(res_full["text"])

    def test_corrupt_pdf(self):
        with pytest.raises(DocParseError):
            doc_read(str(FIX / "corrupt.pdf"))

    def test_max_chars_hard_cap(self):
        # Caller asks for 999999, must be capped to 200000
        res = doc_read(str(FIX / "sample.md"), max_chars=999999)
        assert res["max_chars_applied"] == 200000
```

- [ ] **Step 3: Run**

```bash
cd Clawith/backend && pytest tests/test_doc_tools.py::TestDocRead -v
```

Expected: FAIL — `app.services.doc_parser` missing.

- [ ] **Step 4: Implement doc_read**

Create `Clawith/backend/app/services/doc_parser.py`:

```python
"""Unified document reader for PDF, Office, and plaintext formats.

Public API:
    doc_read(path, page_range="", max_chars=50000) -> dict
    doc_extract_tables(path, page_range="") -> dict

All paths are absolute file paths (returned by playwright_browser_download
as `file_id`, or provided directly for uploaded files).
"""

from __future__ import annotations

from pathlib import Path

from app.services.playwright_client import DocParseError


_MAX_CHARS_HARD_CAP = 200_000


def _parse_page_range(page_range: str, page_count: int) -> list[int]:
    """Return a list of 0-based page indices. Empty string = all pages."""
    if not page_range.strip():
        return list(range(page_count))
    pages: set[int] = set()
    for chunk in page_range.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            try:
                lo_i = int(lo) - 1
                hi_i = int(hi) - 1
            except ValueError:
                raise DocParseError(f"invalid page range: {chunk!r}")
            for i in range(max(0, lo_i), min(page_count - 1, hi_i) + 1):
                pages.add(i)
        else:
            try:
                i = int(chunk) - 1
            except ValueError:
                raise DocParseError(f"invalid page number: {chunk!r}")
            if 0 <= i < page_count:
                pages.add(i)
    return sorted(pages)


def _read_pdf(path: Path, page_range: str) -> tuple[str, int]:
    import pypdf
    try:
        reader = pypdf.PdfReader(str(path))
    except Exception as e:
        raise DocParseError(f"PDF parse failed: {e}")
    count = len(reader.pages)
    if count == 0:
        raise DocParseError("PDF has no pages (file may be corrupt)")
    indices = _parse_page_range(page_range, count)
    parts: list[str] = []
    for i in indices:
        try:
            parts.append(reader.pages[i].extract_text() or "")
        except Exception as e:
            raise DocParseError(f"PDF page {i+1} unreadable: {e}")
    return "\n\n".join(parts), count


def _read_docx(path: Path) -> str:
    from docx import Document
    try:
        doc = Document(str(path))
    except Exception as e:
        raise DocParseError(f"DOCX parse failed: {e}")
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts)


def _read_xlsx(path: Path) -> str:
    from openpyxl import load_workbook
    try:
        wb = load_workbook(str(path), read_only=True, data_only=True)
    except Exception as e:
        raise DocParseError(f"XLSX parse failed: {e}")
    parts: list[str] = []
    for ws in wb.worksheets:
        parts.append(f"### {ws.title}")
        for row in ws.iter_rows(values_only=True):
            parts.append("\t".join("" if c is None else str(c) for c in row))
    return "\n".join(parts)


def _read_pptx(path: Path) -> str:
    from pptx import Presentation
    try:
        prs = Presentation(str(path))
    except Exception as e:
        raise DocParseError(f"PPTX parse failed: {e}")
    parts: list[str] = []
    for i, slide in enumerate(prs.slides, 1):
        parts.append(f"--- Slide {i} ---")
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text:
                parts.append(shape.text)
    return "\n".join(parts)


def _read_plain(path: Path, encoding: str = "utf-8") -> str:
    try:
        return path.read_text(encoding=encoding)
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


_EXT_FORMAT = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".xlsx": "xlsx",
    ".pptx": "pptx",
    ".md": "md",
    ".markdown": "md",
    ".txt": "txt",
    ".csv": "csv",
}


def doc_read(
    file_id_or_path: str,
    page_range: str = "",
    max_chars: int = 50_000,
) -> dict:
    """Read a document and return {text, truncated, format, page_count, max_chars_applied}.

    Supported formats: pdf, docx, xlsx, pptx, md, txt, csv.
    `max_chars` is capped at 200,000 regardless of caller request.
    """
    path = Path(file_id_or_path)
    if not path.exists():
        raise DocParseError(f"file not found: {file_id_or_path}")

    ext = path.suffix.lower()
    fmt = _EXT_FORMAT.get(ext)
    if fmt is None:
        raise DocParseError(f"unsupported extension: {ext}")

    page_count = 1
    if fmt == "pdf":
        text, page_count = _read_pdf(path, page_range)
    elif fmt == "docx":
        text = _read_docx(path)
    elif fmt == "xlsx":
        text = _read_xlsx(path)
    elif fmt == "pptx":
        text = _read_pptx(path)
        page_count = len(__import__("pptx").Presentation(str(path)).slides)
    else:  # md, txt, csv
        text = _read_plain(path)

    applied = min(max_chars, _MAX_CHARS_HARD_CAP)
    truncated = len(text) > applied
    if truncated:
        text = text[:applied]

    return {
        "text": text,
        "truncated": truncated,
        "format": fmt,
        "page_count": page_count,
        "max_chars_applied": applied,
    }
```

- [ ] **Step 5: Run**

```bash
cd Clawith/backend && pytest tests/test_doc_tools.py::TestDocRead -v
```

Expected: all 10 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add Clawith/backend/app/services/doc_parser.py Clawith/backend/tests/test_doc_tools.py Clawith/backend/tests/fixtures/
git commit -m "feat(clawith): add doc_read for pdf/docx/xlsx/pptx/md/txt/csv"
```

---

### Task 12: doc_parser.py — `doc_extract_tables`

**Files:**
- Modify: `Clawith/backend/app/services/doc_parser.py`
- Modify: `Clawith/backend/tests/test_doc_tools.py`

- [ ] **Step 1: Write failing tests**

Append to `test_doc_tools.py`:

```python
from app.services.doc_parser import doc_extract_tables


class TestDocExtractTables:
    def test_xlsx_tables(self):
        res = doc_extract_tables(str(FIX / "sample.xlsx"))
        assert len(res["tables"]) == 2  # two sheets
        t1 = res["tables"][0]
        # First sheet, first row
        assert t1[0] == ["A", "B", "C"]
        assert t1[1] == ["1", "2", "3"]

    def test_pdf_tables_empty_ok(self):
        # Our sample.pdf has no tables — just confirm the call returns an empty list
        res = doc_extract_tables(str(FIX / "sample.pdf"))
        assert "tables" in res
        assert isinstance(res["tables"], list)

    def test_unsupported_format(self):
        with pytest.raises(DocParseError):
            doc_extract_tables(str(FIX / "sample.md"))
```

- [ ] **Step 2: Run**

```bash
cd Clawith/backend && pytest tests/test_doc_tools.py::TestDocExtractTables -v
```

Expected: FAIL — `doc_extract_tables` missing.

- [ ] **Step 3: Implement**

Append to `doc_parser.py`:

```python
def _tables_xlsx(path: Path) -> list[list[list[str]]]:
    from openpyxl import load_workbook
    try:
        wb = load_workbook(str(path), read_only=True, data_only=True)
    except Exception as e:
        raise DocParseError(f"XLSX parse failed: {e}")
    tables = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            rows.append(["" if c is None else str(c) for c in row])
        if rows:
            tables.append(rows)
    return tables


def _tables_pdf(path: Path, page_range: str) -> list[list[list[str]]]:
    import pdfplumber
    try:
        with pdfplumber.open(str(path)) as pdf:
            count = len(pdf.pages)
            indices = _parse_page_range(page_range, count)
            tables: list[list[list[str]]] = []
            for i in indices:
                try:
                    for t in pdf.pages[i].extract_tables() or []:
                        # Normalize None -> ""
                        tables.append([["" if c is None else str(c) for c in row] for row in t])
                except Exception:
                    continue  # skip unreadable pages
            return tables
    except Exception as e:
        raise DocParseError(f"PDF table extraction failed: {e}")


def doc_extract_tables(file_id_or_path: str, page_range: str = "") -> dict:
    """Extract structured tables. Supports xlsx and pdf only."""
    path = Path(file_id_or_path)
    if not path.exists():
        raise DocParseError(f"file not found: {file_id_or_path}")

    ext = path.suffix.lower()
    if ext == ".xlsx":
        tables = _tables_xlsx(path)
    elif ext == ".pdf":
        tables = _tables_pdf(path, page_range)
    else:
        raise DocParseError(f"unsupported for table extraction: {ext}")
    return {"tables": tables, "count": len(tables)}
```

- [ ] **Step 4: Run**

```bash
cd Clawith/backend && pytest tests/test_doc_tools.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add Clawith/backend/app/services/doc_parser.py Clawith/backend/tests/test_doc_tools.py
git commit -m "feat(clawith): add doc_extract_tables for pdf and xlsx"
```

---

### Task 13: Register 18 tools in `AGENT_TOOLS` and `execute_tool()`

**Files:**
- Modify: `Clawith/backend/app/services/agent_tools.py`

- [ ] **Step 1: Read the current AGENT_TOOLS list end**

Open `Clawith/backend/app/services/agent_tools.py` and locate the `AGENT_TOOLS = [` list declaration (around line 173). Scan to its closing bracket — the last entry before `]` is the `install_skill` tool (around line 1466) — actually no, AgentBay tools start at 1467. The list closes somewhere near line 1658. Confirm by running:

```bash
cd Clawith/backend && python -c "
from app.services.agent_tools import AGENT_TOOLS
print(len(AGENT_TOOLS), 'tools currently registered')
print('last tool name:', AGENT_TOOLS[-1]['function']['name'])
"
```

Expected: something like `<N> tools currently registered` and a named tool.

- [ ] **Step 2: Append 18 tool schemas to AGENT_TOOLS**

Find the closing `]` of the `AGENT_TOOLS = [...]` block. Just before it, insert the following block. (Every schema is complete — do not abbreviate.)

```python
    # ── Playwright Browser (built-in) ─────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_navigate",
            "description": "Navigate the built-in headless browser to a URL. Raises an error for local filesystem URLs and internal Docker services. After this call, use playwright_browser_snapshot to see the page structure; do NOT call navigate again just to screenshot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Absolute https:// or http:// URL"},
                    "wait_until": {"type": "string", "enum": ["load", "domcontentloaded", "networkidle"], "default": "load"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_snapshot",
            "description": "Return a text accessibility tree of the current page, with each interactive element tagged [ref=eN]. Use these refs to click/type/select. Refs are invalidated after the next snapshot or navigation.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_click",
            "description": "Click an element by ref (from playwright_browser_snapshot). Do NOT call navigate after clicking — the page may have already navigated; call snapshot or screenshot instead.",
            "parameters": {
                "type": "object",
                "properties": {"ref": {"type": "string", "description": "Element ref from snapshot, e.g. e12"}},
                "required": ["ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_type",
            "description": "Type text into an input/textarea identified by ref. Set submit=true to press Enter after typing (common for search boxes).",
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string"},
                    "text": {"type": "string"},
                    "submit": {"type": "boolean", "default": False},
                },
                "required": ["ref", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_select",
            "description": "Select one or more options in a <select> element by ref.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string"},
                    "values": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["ref", "values"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_hover",
            "description": "Hover the mouse over an element by ref (triggers tooltips / hover menus).",
            "parameters": {
                "type": "object",
                "properties": {"ref": {"type": "string"}},
                "required": ["ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_screenshot",
            "description": "Take a PNG screenshot of the current page. Use only when accessibility snapshot is insufficient (canvas, SVG, etc.).",
            "parameters": {
                "type": "object",
                "properties": {
                    "full_page": {"type": "boolean", "default": False},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_click_xy",
            "description": "Fallback: click at pixel coordinates. Use only when ref-based click fails.",
            "parameters": {
                "type": "object",
                "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}},
                "required": ["x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_type_xy",
            "description": "Fallback: click at (x,y) then type text. Use only when ref-based type fails.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer"}, "y": {"type": "integer"}, "text": {"type": "string"},
                },
                "required": ["x", "y", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_wait_for",
            "description": "Wait for a selector to appear, for text to appear, or for network idle. Exactly one of selector/text may be provided; empty defaults to network-idle wait.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "default": ""},
                    "text": {"type": "string", "default": ""},
                    "timeout_ms": {"type": "integer", "default": 10000},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_eval",
            "description": "Evaluate a JavaScript expression in the page context and return the result. Arbitrary JS runs in the browser sandbox.",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string"}},
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_get_text",
            "description": "Extract visible text from an element (by ref) or the entire page body (ref empty). Prefer doc_read for downloaded files.",
            "parameters": {
                "type": "object",
                "properties": {"ref": {"type": "string", "default": ""}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_back",
            "description": "Navigate back in browser history.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_close_tab",
            "description": "Close the current tab and open a fresh blank one in the same session.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_download",
            "description": "Click an element by ref expected to trigger a file download, save it under this session's download dir, and return {file_id, filename, size, mime}. If file exceeds 100 MB, returns success=false with download_url so you can tell the user to download it manually.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string"},
                    "timeout_ms": {"type": "integer", "default": 30000},
                },
                "required": ["ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playwright_browser_list_downloads",
            "description": "List files already downloaded by this ChatSession. Returns [{filename, size, file_id}].",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    # ── Document parsing (cross-source) ────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "doc_read",
            "description": "Extract plaintext from a document file (pdf/docx/xlsx/pptx/md/txt/csv). file_id_or_path is either a file_id returned by playwright_browser_download or an absolute path. Returns {text, truncated, format, page_count}. max_chars caps output (hard limit 200,000).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id_or_path": {"type": "string"},
                    "page_range": {"type": "string", "default": "", "description": "e.g. '1-3' or '1,3,5'. Empty = all pages. PDF/PPTX only."},
                    "max_chars": {"type": "integer", "default": 50000},
                },
                "required": ["file_id_or_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "doc_extract_tables",
            "description": "Extract structured tables from a pdf or xlsx file. Returns {tables: [[[cell, cell, ...], ...], ...]}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id_or_path": {"type": "string"},
                    "page_range": {"type": "string", "default": ""},
                },
                "required": ["file_id_or_path"],
            },
        },
    },
```

- [ ] **Step 3: Add dispatch branches to `execute_tool()`**

In `execute_tool()` (around line 2391, just before the `# ── Skill Management ──` comment), add:

```python
        # ── Playwright Browser (built-in) ──
        elif tool_name == "playwright_browser_navigate":
            result = await _playwright_browser_navigate(agent_id, arguments)
        elif tool_name == "playwright_browser_snapshot":
            result = await _playwright_browser_snapshot(agent_id, arguments)
        elif tool_name == "playwright_browser_click":
            result = await _playwright_browser_click(agent_id, arguments)
        elif tool_name == "playwright_browser_type":
            result = await _playwright_browser_type(agent_id, arguments)
        elif tool_name == "playwright_browser_select":
            result = await _playwright_browser_select(agent_id, arguments)
        elif tool_name == "playwright_browser_hover":
            result = await _playwright_browser_hover(agent_id, arguments)
        elif tool_name == "playwright_browser_screenshot":
            result = await _playwright_browser_screenshot(agent_id, arguments)
        elif tool_name == "playwright_browser_click_xy":
            result = await _playwright_browser_click_xy(agent_id, arguments)
        elif tool_name == "playwright_browser_type_xy":
            result = await _playwright_browser_type_xy(agent_id, arguments)
        elif tool_name == "playwright_browser_wait_for":
            result = await _playwright_browser_wait_for(agent_id, arguments)
        elif tool_name == "playwright_browser_eval":
            result = await _playwright_browser_eval(agent_id, arguments)
        elif tool_name == "playwright_browser_get_text":
            result = await _playwright_browser_get_text(agent_id, arguments)
        elif tool_name == "playwright_browser_back":
            result = await _playwright_browser_back(agent_id, arguments)
        elif tool_name == "playwright_browser_close_tab":
            result = await _playwright_browser_close_tab(agent_id, arguments)
        elif tool_name == "playwright_browser_download":
            result = await _playwright_browser_download(agent_id, arguments)
        elif tool_name == "playwright_browser_list_downloads":
            result = await _playwright_browser_list_downloads(agent_id, arguments)
        # ── Document parsing ──
        elif tool_name == "doc_read":
            result = await _doc_read_tool(agent_id, arguments)
        elif tool_name == "doc_extract_tables":
            result = await _doc_extract_tables_tool(agent_id, arguments)
```

- [ ] **Step 4: Get chat_session_id from context**

Clawith's tool dispatcher uses a `ContextVar` for session binding (line 19 of `agent_tools.py`: `from contextvars import ContextVar`). Find the existing context var. Run:

```bash
cd Clawith/backend && grep -n "ContextVar\|chat_session_id\|_current_chat_session" app/services/agent_tools.py | head -20
```

If there is a `_current_chat_session` / similar context var, the handler functions must read from it. If there is not, the handlers must fall back to a per-agent singleton session id like `"default"` and accept that multi-session users share one browser (a known limitation — flag in the commit message).

- [ ] **Step 5: Add handler wrapper functions at the end of `agent_tools.py`**

Append at the end of the file (just before the last existing function or at true EOF, outside any class):

```python
# ──────────────────────────────────────────────────────────────────────────
# Playwright Browser handlers
# ──────────────────────────────────────────────────────────────────────────

def _chat_session_id_for_handlers() -> str:
    """Resolve the current ChatSession id from context, fallback to 'default'.

    Replace the implementation here with the project's real context var lookup
    if one exists — see Task 13 Step 4.
    """
    # TODO: if project has a ContextVar for chat session, use it here.
    return "default"


async def _get_playwright_client(agent_id: uuid.UUID):
    from app.services.playwright_client import get_playwright_client_for_session
    return await get_playwright_client_for_session(
        str(agent_id), _chat_session_id_for_handlers()
    )


def _fmt(result) -> str:
    """Standard str serialization for tool results."""
    if isinstance(result, bytes):
        import base64
        return f"<{len(result)}-byte binary; base64 head: {base64.b64encode(result[:60]).decode()}...>"
    import json
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except TypeError:
        return str(result)


async def _playwright_browser_navigate(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_navigate(
        arguments["url"], wait_until=arguments.get("wait_until", "load")
    ))


async def _playwright_browser_snapshot(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_snapshot())


async def _playwright_browser_click(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_click(arguments["ref"]))


async def _playwright_browser_type(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_type(
        arguments["ref"], arguments["text"], submit=arguments.get("submit", False)
    ))


async def _playwright_browser_select(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_select(arguments["ref"], arguments["values"]))


async def _playwright_browser_hover(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_hover(arguments["ref"]))


async def _playwright_browser_screenshot(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    png = await client.browser_screenshot(full_page=arguments.get("full_page", False))
    return _fmt(png)


async def _playwright_browser_click_xy(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_click_xy(arguments["x"], arguments["y"]))


async def _playwright_browser_type_xy(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_type_xy(
        arguments["x"], arguments["y"], arguments["text"]
    ))


async def _playwright_browser_wait_for(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_wait_for(
        selector=arguments.get("selector", ""),
        text=arguments.get("text", ""),
        timeout_ms=arguments.get("timeout_ms", 10000),
    ))


async def _playwright_browser_eval(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_eval(arguments["expression"]))


async def _playwright_browser_get_text(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_get_text(arguments.get("ref", "")))


async def _playwright_browser_back(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_back())


async def _playwright_browser_close_tab(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_close_tab())


async def _playwright_browser_download(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_download(
        arguments["ref"], timeout_ms=arguments.get("timeout_ms", 30000)
    ))


async def _playwright_browser_list_downloads(agent_id, arguments):
    client = await _get_playwright_client(agent_id)
    return _fmt(await client.browser_list_downloads())


async def _doc_read_tool(agent_id, arguments):
    from app.services.doc_parser import doc_read
    try:
        res = doc_read(
            arguments["file_id_or_path"],
            page_range=arguments.get("page_range", ""),
            max_chars=arguments.get("max_chars", 50000),
        )
    except Exception as e:
        return f"doc_read error: {type(e).__name__}: {e}"
    return _fmt(res)


async def _doc_extract_tables_tool(agent_id, arguments):
    from app.services.doc_parser import doc_extract_tables
    try:
        res = doc_extract_tables(
            arguments["file_id_or_path"],
            page_range=arguments.get("page_range", ""),
        )
    except Exception as e:
        return f"doc_extract_tables error: {type(e).__name__}: {e}"
    return _fmt(res)
```

- [ ] **Step 6: Syntax-check**

Run:

```bash
cd Clawith/backend && python -c "import app.services.agent_tools; print('ok, total tools:', len(app.services.agent_tools.AGENT_TOOLS))"
```

Expected: `ok, total tools: <N+18>`.

- [ ] **Step 7: Commit**

```bash
git add Clawith/backend/app/services/agent_tools.py
git commit -m "feat(clawith): register playwright_browser_* and doc_* tools"
```

---

### Task 14: Wire cleanup loop in `main.py` lifespan

**Files:**
- Modify: `Clawith/backend/app/main.py`

- [ ] **Step 1: Add the cleanup coroutine**

Add a small helper near the other coroutines. Near the existing `_start_ss_local` definition in `main.py` (around line 55), add:

```python
async def _playwright_cleanup_loop():
    """Every 60 seconds, reap idle Playwright sessions."""
    import asyncio
    from app.services.playwright_client import cleanup_playwright_sessions
    from loguru import logger

    while True:
        try:
            await cleanup_playwright_sessions()
        except Exception as e:
            logger.warning(f"[Playwright] cleanup loop iteration failed: {e}")
        await asyncio.sleep(60)
```

- [ ] **Step 2: Register in the background task list**

Inside the `lifespan` function, find the loop that creates background tasks (around line 223). Add `playwright_cleanup` to the list:

```python
        for name, coro in [
            ("trigger_daemon", start_trigger_daemon()),
            ("feishu_ws", feishu_ws_manager.start_all()),
            ("dingtalk_stream", dingtalk_stream_manager.start_all()),
            ("wecom_stream", wecom_stream_manager.start_all()),
            ("discord_gw", discord_gateway_manager.start_all()),
            ("playwright_cleanup", _playwright_cleanup_loop()),
        ]:
```

- [ ] **Step 3: Syntax-check**

```bash
cd Clawith/backend && python -c "import app.main"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add Clawith/backend/app/main.py
git commit -m "feat(clawith): run Playwright session cleanup loop at startup"
```

---

### Task 15: Integration test — tool schema registry + dispatch

**Files:**
- Create: `Clawith/backend/tests/test_playwright_agent_integration.py`

- [ ] **Step 1: Write the tests**

Create `Clawith/backend/tests/test_playwright_agent_integration.py`:

```python
"""Smoke tests that the 18 new tools are registered and dispatchable."""

import json
import uuid

import pytest


PLAYWRIGHT_TOOL_NAMES = {
    "playwright_browser_navigate",
    "playwright_browser_snapshot",
    "playwright_browser_click",
    "playwright_browser_type",
    "playwright_browser_select",
    "playwright_browser_hover",
    "playwright_browser_screenshot",
    "playwright_browser_click_xy",
    "playwright_browser_type_xy",
    "playwright_browser_wait_for",
    "playwright_browser_eval",
    "playwright_browser_get_text",
    "playwright_browser_back",
    "playwright_browser_close_tab",
    "playwright_browser_download",
    "playwright_browser_list_downloads",
    "doc_read",
    "doc_extract_tables",
}


def test_all_18_tools_registered():
    from app.services.agent_tools import AGENT_TOOLS
    registered = {t["function"]["name"] for t in AGENT_TOOLS}
    missing = PLAYWRIGHT_TOOL_NAMES - registered
    assert not missing, f"Missing tool schemas: {missing}"


def test_each_tool_has_description_and_parameters():
    from app.services.agent_tools import AGENT_TOOLS
    for t in AGENT_TOOLS:
        if t["function"]["name"] in PLAYWRIGHT_TOOL_NAMES:
            assert t["function"].get("description"), (
                f"{t['function']['name']} has empty description"
            )
            assert t["function"].get("parameters", {}).get("type") == "object"


@pytest.mark.asyncio
async def test_doc_read_dispatch():
    """The dispatcher routes doc_read to _doc_read_tool and returns a JSON string."""
    from pathlib import Path
    from app.services.agent_tools import execute_tool

    fix = Path(__file__).parent / "fixtures" / "sample.md"
    out = await execute_tool(
        tool_name="doc_read",
        arguments={"file_id_or_path": str(fix)},
        agent_id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        ws=Path("/tmp"),
    )
    parsed = json.loads(out)
    assert parsed["format"] == "md"
    assert "Title" in parsed["text"]
```

- [ ] **Step 2: Run**

```bash
cd Clawith/backend && pytest tests/test_playwright_agent_integration.py -v
```

Expected: all 3 tests PASS. If the `execute_tool` signature differs (e.g. takes different arg names), adjust the call in the last test to match the real signature.

- [ ] **Step 3: Commit**

```bash
git add Clawith/backend/tests/test_playwright_agent_integration.py
git commit -m "test(clawith): verify 18 new tools are registered and dispatchable"
```

---

### Task 16: Manual acceptance dry run + final commit

**Files:** None (manual verification only).

- [ ] **Step 1: Build and launch the stack locally**

```bash
docker compose build clawith-backend
docker compose up -d postgres redis clawith-backend
docker compose logs -f clawith-backend | head -50
```

Expected: logs contain `[Playwright] Chromium launched` when the first tool is invoked (Chromium is launched lazily), and `[startup] created bg task: playwright_cleanup` immediately at startup.

- [ ] **Step 2: Run the full test suite inside the built image**

```bash
docker compose run --rm clawith-backend pytest tests/test_playwright_client.py tests/test_doc_tools.py tests/test_playwright_agent_integration.py -v
```

Expected: all tests PASS.

- [ ] **Step 3: End-to-end smoke through a real Agent**

Using Clawith's chat UI or curl, create an Agent with the new tools enabled:
1. Open Clawith UI (`http://localhost:3008`)
2. Create a new Agent "Research Assistant"
3. In the Tools tab, enable `playwright_browser_navigate`, `playwright_browser_snapshot`, `playwright_browser_click`, `playwright_browser_get_text`, `doc_read`
4. Send the message: _"Open https://example.com, read the heading, and tell me what it says."_
5. Expected: the Agent issues `playwright_browser_navigate`, then `playwright_browser_snapshot` or `playwright_browser_get_text`, then returns the heading text.

- [ ] **Step 4: Verify the blocklist**

Send the message: _"Open http://postgres:5432 and tell me what you see."_
Expected: the tool returns a JSON result with `URLBlockedError` in the error string; the Agent reports that the URL is blocked.

- [ ] **Step 5: Verify 5-minute cleanup**

After a successful navigation, wait >5 minutes without further tool calls. Check logs for `[Playwright] Cleaned up session ...`. Confirm `/data/agents/<agent_id>/downloads/<session_id>/` is removed.

- [ ] **Step 6: Tag the plan as complete**

```bash
git tag -a playwright-phase-1.2-done -m "Clawith Phase 1.2 — built-in Playwright browser shipped"
```

---

## Follow-up Work (not in this plan)

- Wire up `cleanup_agentbay_sessions()` the same way (it's orphaned in the code base).
- Add a `ContextVar` for `chat_session_id` if one doesn't exist, replacing the `"default"` fallback in `_chat_session_id_for_handlers()`.
- Per-tenant quota on concurrent Playwright sessions.
- Credential injection from `agent_credentials` table via `context.add_cookies()`.
