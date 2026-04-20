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
