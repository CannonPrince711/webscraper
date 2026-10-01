"""Value coercion, URL normalisation and export safety."""

from __future__ import annotations

import pytest

from app.core.text import clean_text, csv_safe, parse_bool, parse_date, parse_number, snake_case, truncate
from app.core.urlnorm import content_hash, has_document_extension, normalize_url, path_matches_any, url_hash


# ---------------------------------------------------------------------------
# Number parsing — locale ambiguity is the hard part
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("$1,299.00", 1299.0),
        ("1299", 1299),
        ("1.299,00 €", 1299.0),          # German
        ("1 299,00", 1299.0),            # French
        ("€ 1.299", 1299),               # German thousands
        ("12.5", 12.5),
        ("12,5", 12.5),                  # single comma, 1 decimal → decimal sep
        ("1,299", 1299),                 # single comma, 3 digits → thousands sep
        ("1.299.000", 1299000),
        ("1,299,000", 1299000),
        ("(42.50)", -42.5),              # accounting negative
        ("-15%", -15),
        ("1.2K", 1200.0),
        ("3.4M", 3400000.0),
        ("  ", None),
        ("N/A", None),
        ("free", None),
    ],
)
def test_parse_number(raw, expected) -> None:
    assert parse_number(raw) == expected


def test_parse_number_passthrough() -> None:
    assert parse_number(42) == 42
    assert parse_number(3.5) == 3.5
    assert parse_number(True) == 1
    assert parse_number(None) is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("true", True), ("YES", True), ("In Stock", True), ("1", True), ("on", True),
     ("false", False), ("No", False), ("Out of stock", False), ("0", False),
     ("maybe", None), (None, None), (True, True)],
)
def test_parse_bool(raw, expected) -> None:
    assert parse_bool(raw) == expected


def test_parse_date_normalises_to_iso() -> None:
    assert parse_date("March 5, 2024") == "2024-03-05"
    assert parse_date("2024-03-05T10:00:00Z") == "2024-03-05"
    assert parse_date("5 March 2024") == "2024-03-05"
    assert parse_date("not a date at all") is None


def test_clean_text_strips_invisible_characters() -> None:
    assert clean_text("  hello\u200b   world\u00a0 ") == "hello world"
    assert clean_text("<b>bold</b>") == "<b>bold</b>"   # clean_text is not strip_html
    assert clean_text(None) == ""


def test_truncate_adds_ellipsis() -> None:
    assert truncate("abcdefghij", 5) == "abcd…"
    assert truncate("abc", 10) == "abc"
    assert truncate(None) == ""


def test_snake_case() -> None:
    assert snake_case("Product Price") == "product_price"
    assert snake_case("Ünit-Price!!") == "unit_price"   # diacritics folded, separators unified
    assert snake_case("!!!") == "field"


# ---------------------------------------------------------------------------
# CSV injection — a real vulnerability in export features
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "payload",
    ["=cmd|'/c calc'!A1", "+1+1", "-2+3", "@SUM(A1)", "\t=1+1", "\r=1+1", "=HYPERLINK(\"http://evil\")"],
)
def test_csv_formula_injection_is_neutralised(payload: str) -> None:
    assert csv_safe(payload).startswith("'")


def test_csv_safe_leaves_normal_values_alone() -> None:
    assert csv_safe("Normal product") == "Normal product"
    assert csv_safe(None) == ""
    assert csv_safe(42) == "42"


# ---------------------------------------------------------------------------
# URL normalisation and crawl scope
# ---------------------------------------------------------------------------
def test_normalize_url_canonicalises_equivalents() -> None:
    a = normalize_url("https://Shop.example.com/products/?utm_source=newsletter#reviews")
    b = normalize_url("https://shop.example.com/products")
    assert a == b == "https://shop.example.com/products"


def test_normalize_url_strips_default_ports_and_sorts_query() -> None:
    assert normalize_url("https://example.com:443/a?b=2&a=1") == "https://example.com/a?a=1&b=2"


def test_normalize_url_keeps_meaningful_query_params() -> None:
    assert "page=2" in normalize_url("https://example.com/list?page=2&utm_medium=email")


def test_normalize_url_strips_index_documents() -> None:
    # Every root form collapses to the same canonical string, which is what
    # makes crawl de-duplication reliable.
    assert normalize_url("https://example.com/index.html") == "https://example.com/"
    assert normalize_url("https://example.com/index.php") == "https://example.com/"
    assert normalize_url("https://example.com/") == "https://example.com/"


def test_url_hash_is_stable_across_equivalent_urls() -> None:
    assert url_hash("https://example.com/p/") == url_hash("https://example.com/p")


def test_content_hash_ignores_key_order() -> None:
    assert content_hash({"a": 1, "b": 2}) == content_hash({"b": 2, "a": 1})
    assert content_hash({"a": 1}) != content_hash({"a": 2})


@pytest.mark.parametrize("url", ["https://x.com/a.jpg", "https://x.com/a.pdf", "https://x.com/s.js", "https://x.com/f.zip"])
def test_non_document_extensions_detected(url: str) -> None:
    assert has_document_extension(url) is True


@pytest.mark.parametrize("url", ["https://x.com/a", "https://x.com/a.html", "https://x.com/a?x=.jpg"])
def test_document_urls_pass(url: str) -> None:
    assert has_document_extension(url) is False


def test_path_glob_matching() -> None:
    assert path_matches_any("/products/widget", ["/products/**"])
    assert path_matches_any("/products", ["/products"])
    assert not path_matches_any("/cart", ["/products/**"])
    assert not path_matches_any("/products-x/1", ["/products"])
