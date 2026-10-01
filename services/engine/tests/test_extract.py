"""Selector extraction and structural auto-detection."""

from __future__ import annotations

from app.extract.auto import extract_auto, find_repeating_groups, records_from_json_ld
from app.extract.base import extract_records
from app.extract.selectors import extract_with_selectors
from app.models import (
    ExtractField,
    ExtractSpec,
    ExtractStrategy,
    FieldType,
    JobMode,
    ScrapeConfig,
)
from app.parse.dom import parse_html
from app.parse.metadata import extract_json_ld, extract_metadata


def _config(**extract_kwargs) -> ScrapeConfig:
    return ScrapeConfig(targets=["https://shop.example.com/widgets"], mode=JobMode.SINGLE, extract=ExtractSpec(**extract_kwargs))


# ---------------------------------------------------------------------------
# Explicit selectors
# ---------------------------------------------------------------------------
def test_extracts_records_with_explicit_selectors(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector="ul.product-grid li.product-card",
        fields=[
            ExtractField(name="title", selector="h3.product-title"),
            ExtractField(name="price", selector="span.product-price", type=FieldType.NUMBER),
            ExtractField(name="url", selector="a.product-link", attribute="href", type=FieldType.URL),
            ExtractField(name="sku", selector="li.product-card", attribute="data-sku"),
            ExtractField(name="image", selector="img.product-image", attribute="src", type=FieldType.IMAGE),
        ],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/widgets")

    assert len(result.records) == 4
    first = result.records[0]
    assert first["title"] == "Widget 1"
    assert first["price"] == 20.99
    assert first["url"] == "https://shop.example.com/products/item-1"
    assert first["image"] == "https://shop.example.com/img/item-1.jpg"
    assert all(c >= 0.9 for c in result.confidences)


def test_transforms_and_type_coercion(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector="li.product-card",
        fields=[
            ExtractField(name="brand", selector="span.product-brand", transforms=["lower"]),
            ExtractField(name="price_value", selector="span.product-price", transforms=["regex:\\$([0-9.]+)"], type=FieldType.NUMBER),
            ExtractField(name="slug", selector="h3.product-title", transforms=["lower", "replace: :--"]),
        ],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/")
    assert result.records[0]["brand"] == "acme"
    assert result.records[0]["price_value"] == 20.99
    assert result.records[0]["slug"] == "widget--1"


def test_fallback_selectors_are_used_when_primary_misses(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector="li.product-card",
        fields=[
            ExtractField(
                name="title",
                selector="h1.nonexistent",
                fallback_selectors=["h3.nope", "h3.product-title"],
            )
        ],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/")
    assert result.records[0]["title"] == "Widget 1"
    assert result.diagnostics["fields"]["title"]["selector_used"] == "h3.product-title"


def test_missing_required_field_lowers_confidence_and_warns(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector="li.product-card",
        fields=[
            ExtractField(name="title", selector="h3.product-title", required=True),
            ExtractField(name="missing", selector=".does-not-exist", required=True),
        ],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/")
    assert result.confidences[0] < 0.5
    assert any("missing_required" in w for w in result.warnings)


def test_default_and_constant_fields(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector="li.product-card",
        fields=[
            ExtractField(name="source", constant="widget-emporium"),
            ExtractField(name="currency", selector=".nonexistent", default="USD"),
        ],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/")
    assert result.records[0]["source"] == "widget-emporium"
    assert result.records[0]["currency"] == "USD"


def test_dedupe_by_keeps_one_record_per_key(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector="li.product-card",
        fields=[ExtractField(name="brand", selector="span.product-brand")],
        dedupe_by=["brand"],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/")
    assert len(result.records) == 1


def test_selector_list_selector_matching_nothing_is_reported() -> None:
    dom = parse_html("<html><body><p>nothing here</p></body></html>")
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        list_selector=".nope",
        fields=[ExtractField(name="x", selector="p")],
    )
    result = extract_with_selectors(dom, spec, base_url="https://x.com/")
    assert result.records == []
    assert any("list_selector_matched_nothing" in w for w in result.warnings)


def test_json_ld_path_field(sample_product_jsonld_html: str) -> None:
    dom = parse_html(sample_product_jsonld_html)
    json_ld = extract_json_ld(dom)
    spec = ExtractSpec(
        strategy=ExtractStrategy.SELECTORS,
        fields=[
            ExtractField(name="title", selector="h1", json_path="offers.price"),
            ExtractField(name="rating", json_path="aggregateRating.ratingValue", type=FieldType.NUMBER),
        ],
    )
    result = extract_with_selectors(dom, spec, base_url="https://shop.example.com/", json_ld=json_ld)
    assert result.records[0]["rating"] == 4.7


# ---------------------------------------------------------------------------
# Structured data
# ---------------------------------------------------------------------------
def test_json_ld_product_mapping(sample_product_jsonld_html: str) -> None:
    dom = parse_html(sample_product_jsonld_html)
    result = extract_auto(dom, ExtractSpec(), base_url="https://shop.example.com/", json_ld=extract_json_ld(dom))

    assert result.diagnostics["source"] == "json_ld"
    record = result.records[0]
    assert record["title"] == "Super Widget Pro"
    assert record["price"] == 129.95
    assert record["currency"] == "USD"
    assert record["brand"] == "Acme"
    assert record["rating"] == 4.7
    assert record["review_count"] == 128
    assert record["sku"] == "SWP-9000"


def test_json_ld_item_list_produces_multiple_records() -> None:
    html = """<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
      {"@type":"ListItem","position":1,"name":"Alpha","url":"https://x.com/a"},
      {"@type":"ListItem","position":2,"name":"Beta","url":"https://x.com/b"},
      {"@type":"ListItem","position":3,"name":"Gamma","url":"https://x.com/c"}
    ]}</script></head><body></body></html>"""
    dom = parse_html(html)
    records = records_from_json_ld(extract_json_ld(dom))
    assert [r["title"] for r in records] == ["Alpha", "Beta", "Gamma"]


def test_malformed_json_ld_is_ignored() -> None:
    html = """<html><head><script type="application/ld+json">{not json at all}</script></head><body>x</body></html>"""
    assert extract_json_ld(parse_html(html)) == []


# ---------------------------------------------------------------------------
# Structural auto-detection
# ---------------------------------------------------------------------------
def test_auto_detects_repeated_product_cards(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    result = extract_auto(dom, ExtractSpec(), base_url="https://shop.example.com/widgets")

    assert result.diagnostics["source"] == "repeated_structure"
    assert len(result.records) == 4
    # Field names are inferred from the semantic class names.
    assert "title" in result.records[0]
    assert "price" in result.records[0]
    prices = [r.get("price") for r in result.records]
    assert 20.99 in prices and 23.99 in prices


def test_auto_ignores_navigation_lists() -> None:
    """Nav/footer link lists repeat too, but they are not data."""
    html = """<html><body>
    <nav class="main-nav"><ul>
      <li class="nav-item"><a href="/a">Alpha</a></li>
      <li class="nav-item"><a href="/b">Beta</a></li>
      <li class="nav-item"><a href="/c">Gamma</a></li>
      <li class="nav-item"><a href="/d">Delta</a></li>
    </ul></nav>
    <main><p>The actual content of this page.</p></main>
    </body></html>"""
    groups = find_repeating_groups(parse_html(html))
    for group in groups:
        assert "nav" not in group.selector


def test_auto_produces_a_saveable_selector_config(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    result = extract_auto(dom, ExtractSpec(), base_url="https://shop.example.com/widgets")

    assert result.suggested_config is not None
    assert result.suggested_config["listSelector"]
    assert result.suggested_config["fields"]


def test_auto_extracts_article_metadata_as_single_record() -> None:
    html = """<html><head>
      <meta property="og:title" content="How widgets work">
      <meta name="description" content="A deep dive into widget mechanics.">
      <meta property="article:published_time" content="2024-05-01T09:00:00Z">
      <meta name="author" content="Jane Smith">
    </head><body><article><h1>How widgets work</h1><p>Widgets are fascinating.</p></article></body></html>"""
    dom = parse_html(html)
    metadata = extract_metadata(dom, "https://blog.example.com/widgets")
    result = extract_auto(dom, ExtractSpec(), base_url="https://blog.example.com/widgets", metadata=metadata)

    assert result.records
    assert result.records[0]["title"] == "How widgets work"
    assert result.records[0]["author"] == "Jane Smith"
    assert result.records[0]["published_at"] == "2024-05-01"


async def test_extract_records_dispatch_auto(sample_listing_html: str) -> None:
    dom = parse_html(sample_listing_html)
    result = await extract_records(
        dom, _config(strategy=ExtractStrategy.AUTO), base_url="https://shop.example.com/widgets"
    )
    assert result.strategy == "auto"
    assert len(result.records) == 4


async def test_llm_strategy_without_provider_degrades() -> None:
    dom = parse_html("<html><body><p>x</p></body></html>")
    result = await extract_records(
        dom, _config(strategy=ExtractStrategy.LLM), base_url="https://x.com/", allow_llm=True
    )
    assert result.records == []
    assert "llm_not_configured" in result.warnings
