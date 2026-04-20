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
    def test_allows_public_https(self, monkeypatch):
        import socket

        def fake_getaddrinfo(host, *args, **kwargs):
            # Return a known public IP that won't be classified as private
            return [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))]

        monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
        _check_url_safe("https://example.com/path?q=1")  # should not raise

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
        refs = re.findall(r"\[ref=([\w\-]+)\]", snap1["tree"])
        assert refs, "no refs in snapshot"
        stale_ref = refs[0]

        # Navigate elsewhere and take a new snapshot — the old ref is stale
        await client._page.goto(f"{local_http_server}/form")
        await client.browser_snapshot()
        with pytest.raises(RefExpiredError):
            client._resolve_ref(stale_ref)


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
        # The "Next" link is near top-left, click at its center
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
