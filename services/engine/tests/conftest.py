"""Shared test fixtures.

Tests must never touch the real network: DNS is stubbed to a public address,
and the HTTP transport is mocked per-test with `respx`. The two exceptions are
explicitly marked — a handful of parser tests run entirely offline anyway.
"""

from __future__ import annotations

import pytest

from app.config import settings

PUBLIC_IP = "93.184.216.34"          # example.com
PUBLIC_IP_2 = "93.184.216.35"
TEST_API_KEY = "test-engine-key"


@pytest.fixture(autouse=True)
def test_settings(monkeypatch):
    """Deterministic settings for every test."""
    monkeypatch.setattr(settings, "engine_api_key", TEST_API_KEY, raising=False)
    monkeypatch.setattr(settings, "engine_require_signature", False, raising=False)
    monkeypatch.setattr(settings, "respect_robots", True, raising=False)
    monkeypatch.setattr(settings, "allow_private_networks", False, raising=False)
    monkeypatch.setattr(settings, "enable_browser", False, raising=False)
    monkeypatch.setattr(settings, "redis_url", None, raising=False)
    monkeypatch.setattr(settings, "proxy_urls", [], raising=False)
    # Hermetic: a developer's real `.env` must never leak credentials into tests.
    monkeypatch.setattr(settings, "decodo_username", None, raising=False)
    monkeypatch.setattr(settings, "decodo_password", None, raising=False)
    monkeypatch.setattr(settings, "decodo_country", None, raising=False)
    monkeypatch.setattr(settings, "decodo_endpoint", "gate.decodo.com:7000", raising=False)
    monkeypatch.setattr(settings, "decodo_session_minutes", 10, raising=False)
    monkeypatch.setattr(settings, "max_concurrency", 4, raising=False)
    monkeypatch.setattr(settings, "ai_base_url", None, raising=False)
    monkeypatch.setattr(settings, "ai_api_key", None, raising=False)
    yield settings


@pytest.fixture(autouse=True)
async def fake_dns(monkeypatch):
    """Resolve every test hostname to a public IP, unless the test overrides."""
    from app.core import ssrf

    async def _resolve(host: str) -> list[str]:
        return [PUBLIC_IP]

    monkeypatch.setattr(ssrf, "resolve_host", _resolve)
    return _resolve


@pytest.fixture
def client():
    """A TestClient over the real ASGI app, with startup/shutdown run."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TEST_API_KEY}"}


@pytest.fixture
def sample_listing_html() -> str:
    """A realistic product-listing page: 4 repeated cards + nav noise."""
    cards = "\n".join(
        f"""
        <li class="product-card" data-sku="SKU-{i}">
          <a class="product-link" href="/products/item-{i}">
            <img class="product-image" src="/img/item-{i}.jpg" alt="Widget {i}">
            <h3 class="product-title">Widget {i}</h3>
          </a>
          <span class="product-price">${19 + i}.99</span>
          <span class="product-brand">Acme</span>
          <p class="product-description">A very fine widget numbered {i}.</p>
          <time class="product-date" datetime="2024-0{i}-15">March {i}, 2024</time>
        </li>
        """
        for i in range(1, 5)
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <title>Widgets for sale</title>
  <meta name="description" content="A catalogue of fine widgets.">
  <meta property="og:title" content="Widgets for sale">
  <meta property="og:site_name" content="Widget Emporium">
  <link rel="canonical" href="https://shop.example.com/widgets">
  <script type="application/ld+json">
  {{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
    {{"@type":"ListItem","position":1,"name":"Home","item":"https://shop.example.com/"}},
    {{"@type":"ListItem","position":2,"name":"Widgets","item":"https://shop.example.com/widgets"}}
  ]}}
  </script>
</head>
<body>
  <nav class="main-nav"><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
  <header class="site-header"><h1>Widgets for sale</h1></header>
  <main>
    <ul class="product-grid">
      {cards}
    </ul>
    <div class="pagination"><a rel="next" href="/widgets?page=2">Next</a></div>
  </main>
  <footer class="site-footer"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
  <script>window.__DATA__ = {{"tracking": true}};</script>
</body>
</html>"""


@pytest.fixture
def sample_product_jsonld_html() -> str:
    return """<!DOCTYPE html>
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Super Widget Pro",
  "description": "The finest widget ever made.",
  "sku": "SWP-9000",
  "brand": {"@type": "Brand", "name": "Acme"},
  "image": ["https://shop.example.com/img/super-widget.png"],
  "offers": {
    "@type": "Offer",
    "price": "129.95",
    "priceCurrency": "USD",
    "availability": "https://schema.org/InStock",
    "url": "https://shop.example.com/products/super-widget"
  },
  "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.7", "reviewCount": "128"}
}
</script>
</head><body><h1>Super Widget Pro</h1></body></html>"""
