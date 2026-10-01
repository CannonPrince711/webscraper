"""robots.txt evaluation, sitemap parsing and request authentication."""

from __future__ import annotations

import asyncio
import gzip
import time

import httpx
import pytest
import respx

from app.config import settings
from app.core.robots import RobotsCache, check_robots
from app.core.security import (
    build_signature,
    hash_api_key,
    verify_api_key,
    verify_signature,
)
from app.core.sitemap import decode_sitemap_bytes, parse_sitemap, sitemap_urls_from_robots
from app.errors import Unauthorized

ROBOTS_TXT = """# Sample robots
User-agent: *
Disallow: /private/
Disallow: /cart
Allow: /private/public-page
Crawl-delay: 1.5

User-agent: WebscraperBot
Disallow: /no-bots/

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml
"""


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    """A clean robots cache per test — the cache is process-global by design."""
    cache = RobotsCache()
    monkeypatch.setattr("app.core.robots.robots_cache", cache)
    yield cache


@respx.mock
async def test_disallowed_path_is_blocked() -> None:
    respx.get("https://example.com/robots.txt").mock(
        return_value=httpx.Response(200, text=ROBOTS_TXT, headers={"content-type": "text/plain"})
    )

    decision = await check_robots("https://example.com/private/secret")
    assert decision.allowed is False
    assert decision.reason == "disallowed"


@respx.mock
async def test_allowed_path_passes_with_crawl_delay() -> None:
    respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(200, text=ROBOTS_TXT))

    decision = await check_robots("https://example.com/products/widget")
    assert decision.allowed is True
    assert decision.crawl_delay == 1.5
    assert "https://example.com/sitemap.xml" in decision.sitemaps


@respx.mock
async def test_specific_user_agent_rules_are_honoured() -> None:
    respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(200, text=ROBOTS_TXT))
    decision = await check_robots("https://example.com/no-bots/page")
    assert decision.allowed is False


@respx.mock
async def test_missing_robots_means_allowed() -> None:
    """A 404 is an explicit "no rules" signal per RFC 9309."""
    respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(404))
    decision = await check_robots("https://example.com/anything")
    assert decision.allowed is True
    assert decision.reason == "no_rules"


@respx.mock
async def test_server_error_fails_closed() -> None:
    """A site whose robots.txt is broken is not inviting a crawl."""
    respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(503))
    decision = await check_robots("https://example.com/page")
    assert decision.allowed is False
    assert decision.reason == "robots_unavailable"


@respx.mock
async def test_robots_is_fetched_once_per_origin() -> None:
    route = respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(200, text=ROBOTS_TXT))

    await check_robots("https://example.com/a")
    await check_robots("https://example.com/b")
    await check_robots("https://example.com/c/deep/path")

    assert route.call_count == 1, "robots.txt must be cached, not refetched per URL"


@respx.mock
async def test_cache_expiry_triggers_a_refetch(monkeypatch) -> None:
    route = respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(200, text=ROBOTS_TXT))
    monkeypatch.setattr(settings, "robots_cache_ttl_seconds", 0, raising=False)

    await check_robots("https://example.com/a")
    await asyncio.sleep(0.01)
    await check_robots("https://example.com/b")
    assert route.call_count == 2


@respx.mock
async def test_respect_robots_false_bypasses_checks(monkeypatch) -> None:
    monkeypatch.setattr(settings, "respect_robots", False, raising=False)
    respx.get("https://example.com/robots.txt").mock(return_value=httpx.Response(200, text=ROBOTS_TXT))

    decision = await check_robots("https://example.com/private/x")
    assert decision.allowed is True
    assert decision.reason == "robots_disabled"


# ---------------------------------------------------------------------------
# Sitemaps
# ---------------------------------------------------------------------------
def test_parse_urlset_sitemap() -> None:
    xml = """<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a</loc><lastmod>2024-03-01</lastmod><priority>0.8</priority></url>
      <url><loc>https://example.com/b</loc><changefreq>daily</changefreq></url>
    </urlset>"""
    result = parse_sitemap(xml)
    assert len(result.entries) == 2
    assert result.entries[0].url == "https://example.com/a"
    assert result.entries[0].lastmod.date().isoformat() == "2024-03-01"
    assert result.entries[1].changefreq == "daily"


def test_parse_sitemap_index_lists_nested_sitemaps() -> None:
    xml = """<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
    </sitemapindex>"""
    result = parse_sitemap(xml)
    assert result.nested_sitemaps == ["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"]
    assert result.entries == []


def test_parse_plain_text_sitemap() -> None:
    result = parse_sitemap("https://example.com/a\nhttps://example.com/b\nnot a url\n")
    assert [e.url for e in result.entries] == ["https://example.com/a", "https://example.com/b"]


def test_malformed_sitemap_returns_empty_not_raises() -> None:
    assert parse_sitemap("<urlset><url><loc>unclosed").entries == []
    assert parse_sitemap("").entries == []


def test_decode_gzipped_sitemap() -> None:
    xml = b'<?xml version="1.0"?><urlset><url><loc>https://example.com/x</loc></url></urlset>'
    assert "https://example.com/x" in decode_sitemap_bytes(gzip.compress(xml))


def test_sitemap_fallback_conventions() -> None:
    assert sitemap_urls_from_robots((), "https://example.com") == [
        "https://example.com/sitemap.xml",
        "https://example.com/sitemap_index.xml",
    ]
    assert sitemap_urls_from_robots(("https://x.com/s.xml",), "https://example.com") == ["https://x.com/s.xml"]


# ---------------------------------------------------------------------------
# Authentication primitives
# ---------------------------------------------------------------------------
def test_verify_api_key_accepts_correct_key() -> None:
    verify_api_key("Bearer test-engine-key", expected="test-engine-key")


@pytest.mark.parametrize(
    "header",
    ["Bearer wrong", "Basic dGVzdA==", "test-engine-key", "", "Bearer "],
)
def test_verify_api_key_rejects_bad_headers(header: str) -> None:
    with pytest.raises(Unauthorized):
        verify_api_key(header, expected="test-engine-key")


def test_verify_api_key_rejects_missing_header() -> None:
    with pytest.raises(Unauthorized):
        verify_api_key(None, expected="test-engine-key")


def test_hmac_signature_round_trip() -> None:
    body = b'{"hello":"world"}'
    header = build_signature(body, secret="s3cret")
    verify_signature(header, body, secret="s3cret")


def test_hmac_rejects_tampered_body() -> None:
    header = build_signature(b'{"amount": 10}', secret="s3cret")
    with pytest.raises(Unauthorized):
        verify_signature(header, b'{"amount": 1000000}', secret="s3cret")


def test_hmac_rejects_stale_timestamp() -> None:
    body = b"{}"
    old = int(time.time()) - 3600
    header = build_signature(body, old, secret="s3cret")
    with pytest.raises(Unauthorized) as exc:
        verify_signature(header, body, secret="s3cret", max_skew=300)
    assert exc.value.details["reason"] == "stale_signature"


def test_hmac_rejects_wrong_secret() -> None:
    body = b"{}"
    header = build_signature(body, secret="theirs")
    with pytest.raises(Unauthorized):
        verify_signature(header, body, secret="ours")


@pytest.mark.parametrize("header", ["", "garbage", "t=abc,v1=def", "v1=only"])
def test_hmac_rejects_malformed_headers(header: str) -> None:
    with pytest.raises(Unauthorized):
        verify_signature(header, b"{}", secret="s3cret")


def test_api_key_hashing_is_deterministic_and_pepperable() -> None:
    assert hash_api_key("ws_live_abc") == hash_api_key("ws_live_abc")
    assert hash_api_key("ws_live_abc") != hash_api_key("ws_live_abc", pepper="org-1")
    assert hash_api_key("ws_live_abc") != hash_api_key("ws_live_abd")
    # The hash must not contain the original secret.
    assert "ws_live_abc" not in hash_api_key("ws_live_abc")
