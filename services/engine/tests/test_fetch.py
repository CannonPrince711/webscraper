"""HTTP fetcher: size caps, compression bombs, redirects, retries."""

from __future__ import annotations

import gzip
import zlib

import httpx
import pytest
import respx

from app.config import settings
from app.errors import FetchFailed, ResponseTooLarge, SSRFBlocked, UnsupportedContentType
from app.fetch.http import _decompress, build_pinned_request, decode_body, http_fetcher
from app.models import FetchSpec


@pytest.fixture(autouse=True)
def unpinned(monkeypatch):
    """Keep the request URL as the hostname so respx can route it.

    IP pinning is verified separately in `test_build_pinned_request`.
    """
    monkeypatch.setattr(settings, "pin_resolved_ip", False, raising=False)


@pytest.fixture(autouse=True)
async def _close_clients():
    yield
    await http_fetcher.aclose()


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------
@respx.mock
async def test_fetch_returns_body_and_metadata() -> None:
    respx.get("https://example.com/page").mock(
        return_value=httpx.Response(
            200,
            html="<html><head><title>Hi</title></head><body>Hello</body></html>",
            headers={"content-type": "text/html; charset=utf-8"},
        )
    )

    result = await http_fetcher.fetch("https://example.com/page", FetchSpec())
    assert result.status == "ok"
    assert result.http_status == 200
    assert "Hello" in result.body
    assert result.fetch_method == "http"
    assert result.content_type == "text/html"


@respx.mock
async def test_http_error_is_reported_not_raised() -> None:
    respx.get("https://example.com/missing").mock(return_value=httpx.Response(404))

    result = await http_fetcher.fetch("https://example.com/missing", FetchSpec())
    assert result.status == "http_error"
    assert result.http_status == 404
    assert result.error_code == "http_404"


@respx.mock
async def test_retries_transient_5xx_then_succeeds(monkeypatch) -> None:
    """Two 503s then a 200 — the caller should never see the failures."""
    import asyncio

    monkeypatch.setattr(asyncio, "sleep", _no_sleep)

    route = respx.get("https://example.com/flaky")
    route.side_effect = [
        httpx.Response(503),
        httpx.Response(503),
        httpx.Response(200, html="<html><body>finally</body></html>"),
    ]

    result = await http_fetcher.fetch("https://example.com/flaky", FetchSpec())
    assert result.status == "ok"
    assert "finally" in result.body


@respx.mock
async def test_persistent_5xx_returns_http_error(monkeypatch) -> None:
    import asyncio

    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    respx.get("https://example.com/down").mock(return_value=httpx.Response(503))

    result = await http_fetcher.fetch("https://example.com/down", FetchSpec())
    assert result.status == "http_error"
    assert result.http_status == 503


# ---------------------------------------------------------------------------
# Size and compression limits
# ---------------------------------------------------------------------------
@respx.mock
async def test_response_size_limit_enforced_while_streaming() -> None:
    payload = b"x" * 200_000
    respx.get("https://example.com/huge").mock(
        return_value=httpx.Response(200, content=payload, headers={"content-type": "text/plain"})
    )

    with pytest.raises(ResponseTooLarge):
        await http_fetcher.fetch("https://example.com/huge", FetchSpec(max_bytes=10_000))


@respx.mock
async def test_declared_content_length_beyond_limit_rejected_early() -> None:
    respx.get("https://example.com/big").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/plain", "content-length": "999999999"},
            content=b"small",
        )
    )
    with pytest.raises(ResponseTooLarge):
        await http_fetcher.fetch("https://example.com/big", FetchSpec(max_bytes=10_000))


@respx.mock
async def test_gzip_is_transparently_decoded() -> None:
    raw = b"<html><body>" + b"compressible content " * 50 + b"</body></html>"
    respx.get("https://example.com/gz").mock(
        return_value=httpx.Response(
            200,
            content=gzip.compress(raw),
            headers={"content-type": "text/html", "content-encoding": "gzip"},
        )
    )

    result = await http_fetcher.fetch("https://example.com/gz", FetchSpec())
    assert "compressible content" in result.body
    assert result.body_bytes == len(gzip.compress(raw))


def test_decompression_bomb_is_capped() -> None:
    """A tiny payload that inflates past the limit must be stopped mid-stream."""
    bomb = gzip.compress(b"0" * 20_000_000)
    assert len(bomb) < 100_000

    with pytest.raises(ResponseTooLarge):
        _decompress(bomb, "gzip", limit=100_000)


def test_decompression_of_normal_payload_works() -> None:
    raw = b"hello world " * 100
    assert _decompress(gzip.compress(raw), "gzip", limit=1_000_000) == raw
    assert _decompress(zlib.compress(raw), "deflate", limit=1_000_000) == raw
    assert _decompress(raw, "identity", limit=1_000_000) == raw


def test_unsupported_content_encoding_rejected() -> None:
    with pytest.raises(UnsupportedContentType):
        _decompress(b"\x00\x01", "br", limit=1000)


@respx.mock
async def test_non_textual_content_type_rejected() -> None:
    respx.get("https://example.com/img").mock(
        return_value=httpx.Response(200, content=b"\x89PNG", headers={"content-type": "image/png"})
    )
    with pytest.raises(UnsupportedContentType):
        await http_fetcher.fetch("https://example.com/img", FetchSpec())


# ---------------------------------------------------------------------------
# Redirects — every hop is re-validated
# ---------------------------------------------------------------------------
@respx.mock
async def test_redirect_chain_is_followed_and_recorded() -> None:
    respx.get("http://example.com/start").mock(
        return_value=httpx.Response(301, headers={"location": "https://example.com/middle"})
    )
    respx.get("https://example.com/middle").mock(
        return_value=httpx.Response(302, headers={"location": "https://example.com/end"})
    )
    respx.get("https://example.com/end").mock(return_value=httpx.Response(200, html="<html>done</html>"))

    result = await http_fetcher.fetch("http://example.com/start", FetchSpec(), depth=0)
    assert result.final_url == "https://example.com/end"
    assert len(result.redirect_chain) == 2
    assert "done" in result.body


@respx.mock
async def test_redirect_to_private_address_is_blocked() -> None:
    """The public URL is fine; the hop it points at is not."""
    respx.get("https://example.com/lure").mock(
        return_value=httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
    )

    with pytest.raises(SSRFBlocked):
        await http_fetcher.fetch("https://example.com/lure", FetchSpec())


@respx.mock
async def test_redirect_loop_hits_the_hop_limit() -> None:
    respx.get("https://example.com/loop").mock(
        return_value=httpx.Response(302, headers={"location": "https://example.com/loop"})
    )
    with pytest.raises(FetchFailed) as exc:
        await http_fetcher.fetch("https://example.com/loop", FetchSpec(max_redirects=2))
    assert "redirect" in exc.value.message.lower()


@respx.mock
async def test_redirects_can_be_disabled() -> None:
    respx.get("https://example.com/noredir").mock(
        return_value=httpx.Response(302, headers={"location": "https://example.com/elsewhere"})
    )
    result = await http_fetcher.fetch("https://example.com/noredir", FetchSpec(follow_redirects=False))
    # A 3xx with no follow is returned as-is rather than treated as an error.
    assert result.http_status == 302


# ---------------------------------------------------------------------------
# Request construction
# ---------------------------------------------------------------------------
def test_build_pinned_request_preserves_host_and_sni() -> None:
    from app.core.ssrf import ValidatedTarget

    target = ValidatedTarget(
        url="https://example.com/secret?a=1",
        scheme="https",
        host="example.com",
        port=443,
        resolved_ips=["93.184.216.34"],
        pinned_ip="93.184.216.34",
    )
    client = httpx.AsyncClient()
    request = build_pinned_request(client, "GET", target, {"Accept": "text/html"})

    assert request.url.host == "93.184.216.34"       # connect by validated IP
    assert request.headers["Host"] == "example.com"  # virtual hosting preserved
    assert request.extensions["sni_hostname"] == "example.com"  # cert validation preserved


def test_build_pinned_request_includes_non_default_port() -> None:
    from app.core.ssrf import ValidatedTarget

    target = ValidatedTarget(
        url="https://example.com:8443/x", scheme="https", host="example.com", port=8443,
        resolved_ips=["93.184.216.34"], pinned_ip="93.184.216.34",
    )
    client = httpx.AsyncClient()
    request = build_pinned_request(client, "GET", target, {})
    assert request.url.port == 8443
    assert request.headers["Host"] == "example.com:8443"


def test_decode_body_respects_declared_charset() -> None:
    latin = "café".encode("latin-1")
    assert decode_body(latin, "text/html; charset=latin-1") == "café"
    assert decode_body("café".encode(), "text/html; charset=utf-8") == "café"
    # Undeclared and invalid bytes must not raise.
    assert decode_body(b"\xff\xfe", "text/html") is not None


@respx.mock
async def test_custom_headers_are_sent() -> None:
    route = respx.get("https://example.com/h").mock(return_value=httpx.Response(200, html="<html>x</html>"))
    await http_fetcher.fetch("https://example.com/h", FetchSpec(headers={"X-Custom": "value"}), depth=0)
    assert route.calls.last.request.headers["X-Custom"] == "value"


def _no_sleep(*_args, **_kwargs):
    async def _inner():
        return None

    return _inner()
