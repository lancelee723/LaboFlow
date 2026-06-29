"""Tests for SSO URL resolution under reverse-proxy scenarios."""

from __future__ import annotations

from starlette.requests import Request

from app.api.enterprise import _request_origin_parts, _resolve_browser_kb_url


def _make_request(
    headers: list[tuple[bytes, bytes]],
    scheme: str = "http",
    server: tuple[str, int] = ("backend", 8000),
) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "headers": headers,
        "scheme": scheme,
        "server": server,
        "path": "/",
        "query_string": b"",
        "root_path": "",
    }
    return Request(scope)


class TestRequestOriginParts:
    def test_https_tunnel_drops_xforwarded_port_80(self):
        # FN Connect tunnel: external HTTPS:443 → internal nginx:80.
        # nginx sends X-Forwarded-Port: 80 (its $server_port) while the
        # Host header from the external client has no port (HTTPS default).
        # The resolved port MUST be None — surfacing :80 would point the
        # browser at the wrong port on the tunnel hostname.
        req = _make_request([
            (b"host", b"customicon-laboflow.senying.fnos.net"),
            (b"x-forwarded-proto", b"https"),
            (b"x-forwarded-host", b"customicon-laboflow.senying.fnos.net"),
            (b"x-forwarded-port", b"80"),
        ])
        scheme, host, port = _request_origin_parts(req)
        assert scheme == "https"
        assert host == "customicon-laboflow.senying.fnos.net"
        assert port is None

    def test_http_default_port_80_in_host_dropped(self):
        req = _make_request([(b"host", b"localhost:80")])
        scheme, _host, port = _request_origin_parts(req)
        assert scheme == "http"
        assert port is None

    def test_https_default_port_443_in_host_dropped(self):
        req = _make_request([
            (b"host", b"example.com:443"),
            (b"x-forwarded-proto", b"https"),
        ])
        _scheme, _host, port = _request_origin_parts(req)
        assert port is None

    def test_non_default_port_preserved(self):
        req = _make_request([(b"host", b"localhost:3008")])
        _scheme, _host, port = _request_origin_parts(req)
        assert port == 3008

    def test_https_with_explicit_non_default_port_preserved(self):
        req = _make_request([
            (b"host", b"example.com:8443"),
            (b"x-forwarded-proto", b"https"),
        ])
        _scheme, _host, port = _request_origin_parts(req)
        assert port == 8443


class TestResolveBrowserKbUrl:
    def test_relative_path_under_https_tunnel_drops_internal_port(self):
        # Regression for the FN Connect bug: PPT-Master URL must be
        # https://host/ppt-master, not https://host:80/ppt-master.
        req = _make_request([
            (b"host", b"customicon-laboflow.senying.fnos.net"),
            (b"x-forwarded-proto", b"https"),
            (b"x-forwarded-host", b"customicon-laboflow.senying.fnos.net"),
            (b"x-forwarded-port", b"80"),
        ])
        url = _resolve_browser_kb_url("/ppt-master", req)
        assert url == "https://customicon-laboflow.senying.fnos.net/ppt-master"

    def test_relative_path_local_dev_preserves_real_port(self):
        req = _make_request([(b"host", b"localhost:3008")])
        url = _resolve_browser_kb_url("/pro-slides", req)
        assert url == "http://localhost:3008/pro-slides"
