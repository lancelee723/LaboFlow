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
            headers={
                "Content-Disposition": 'attachment; filename="dl.bin"',
                "Content-Length": str(n),
            },
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

    try:
        yield base_url
    finally:
        await runner.cleanup()


@pytest.fixture
def bypass_url_check(monkeypatch):
    """Replace _check_url_safe with a no-op so tests can use 127.0.0.1."""
    from app.services import playwright_client
    monkeypatch.setattr(playwright_client, "_check_url_safe", lambda url: None)
