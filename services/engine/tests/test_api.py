"""End-to-end API tests through the real ASGI app.

These exercise auth, request validation, error envelopes and the extract path
without touching the network — the pipeline's own network behaviour is covered
by the fetcher and robots suites.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
def test_healthz_is_unauthenticated_and_cheap(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz_reports_capabilities(client: TestClient) -> None:
    response = client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["version"]
    # Responses use the same camelCase contract as the TypeScript client.
    assert "browserAvailable" in body
    assert "aiEnabled" in body
    assert body["checks"]["respect_robots"] is True


def test_index_lists_endpoints(client: TestClient) -> None:
    body = client.get("/").json()
    assert "POST /v1/scrape" in body["endpoints"]


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
def test_scrape_requires_authentication(client: TestClient) -> None:
    response = client.post("/v1/scrape", json={"config": {"version": 1, "targets": ["https://example.com"]}})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert response.headers.get("www-authenticate") == "Bearer"


def test_wrong_key_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/v1/scrape",
        json={"config": {"version": 1, "targets": ["https://example.com"]}},
        headers={"Authorization": "Bearer nope"},
    )
    assert response.status_code == 401


def test_security_headers_are_present(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "x-request-id" in response.headers


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def test_invalid_config_returns_field_level_problems(client: TestClient, auth_headers) -> None:
    response = client.post("/v1/scrape", json={"config": {"version": 1, "targets": []}}, headers=auth_headers)
    assert response.status_code == 422
    payload = response.json()["error"]
    assert payload["code"] == "invalid_config"
    assert payload["details"]["problems"]


def test_selectors_strategy_requires_fields(client: TestClient, auth_headers) -> None:
    response = client.post(
        "/v1/scrape",
        json={
            "config": {
                "version": 1,
                "targets": ["https://example.com"],
                "extract": {"strategy": "selectors", "fields": []},
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 422
    problems = response.json()["error"]["details"]["problems"]
    assert problems
    # Cross-field rules attach to the model root; the message must still say
    # what is wrong, since a bare "(root)" would be useless in the UI.
    assert any("field" in p["message"].lower() for p in problems)


def test_crlf_injection_in_headers_is_rejected(client: TestClient, auth_headers) -> None:
    """A custom header must never be able to split the outbound request."""
    response = client.post(
        "/v1/scrape",
        json={
            "config": {
                "version": 1,
                "targets": ["https://example.com"],
                "fetch": {"headers": {"X-Evil": "value\r\nX-Injected: 1"}},
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 422
    problems = response.json()["error"]["details"]["problems"]
    assert any("control characters" in p["message"] for p in problems)


def test_hop_by_hop_header_override_is_rejected(client: TestClient, auth_headers) -> None:
    response = client.post(
        "/v1/scrape",
        json={
            "config": {
                "version": 1,
                "targets": ["https://example.com"],
                "fetch": {"headers": {"Host": "evil.example.com"}},
            }
        },
        headers=auth_headers,
    )
    assert response.status_code == 422
    assert any("cannot be overridden" in p["message"] for p in response.json()["error"]["details"]["problems"])


def test_field_name_prototype_pollution_is_rejected(client: TestClient, auth_headers) -> None:
    response = client.post(
        "/v1/extract",
        json={
            "html": "<html><body><p>x</p></body></html>",
            "config": {
                "version": 1,
                "targets": ["https://example.com"],
                "extract": {"strategy": "selectors", "fields": [{"name": "__proto__", "selector": "p"}]},
            },
        },
        headers=auth_headers,
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Extraction over the API
# ---------------------------------------------------------------------------
def test_extract_from_inline_html(client: TestClient, auth_headers, sample_listing_html: str) -> None:
    response = client.post(
        "/v1/extract",
        json={
            "html": sample_listing_html,
            "url": "https://shop.example.com/widgets",
            "config": {
                "version": 1,
                "targets": ["https://shop.example.com/widgets"],
                "extract": {
                    "strategy": "selectors",
                    "listSelector": "li.product-card",
                    "fields": [
                        {"name": "title", "selector": "h3.product-title"},
                        {"name": "price", "selector": "span.product-price", "type": "number"},
                    ],
                },
            },
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["records"]) == 4
    assert body["records"][0]["title"] == "Widget 1"
    assert body["records"][0]["price"] == 20.99


def test_auto_extraction_over_the_api(client: TestClient, auth_headers, sample_listing_html: str) -> None:
    response = client.post(
        "/v1/extract",
        json={
            "html": sample_listing_html,
            "url": "https://shop.example.com/widgets",
            "config": {"version": 1, "targets": ["https://shop.example.com/widgets"]},
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["records"]) == 4
    assert body["suggestedConfig"]["listSelector"]


def test_extract_requires_a_source(client: TestClient, auth_headers) -> None:
    response = client.post(
        "/v1/extract",
        json={"config": {"version": 1, "targets": ["https://example.com"]}},
        headers=auth_headers,
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Selector preview
# ---------------------------------------------------------------------------
def test_selector_preview_reports_matches_and_samples(client: TestClient, auth_headers, sample_listing_html: str) -> None:
    response = client.post(
        "/v1/selectors/preview",
        json={
            "html": sample_listing_html,
            "selectors": [
                {"name": "title", "selector": "h3.product-title"},
                {"name": "missing", "selector": ".does-not-exist"},
                {"name": "href", "selector": "a.product-link", "attribute": "href"},
            ],
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    probes = {p["name"]: p for p in response.json()}
    assert probes["title"]["matches"] == 4
    assert probes["title"]["samples"][0] == "Widget 1"
    assert probes["missing"]["matches"] == 0
    assert probes["href"]["samples"][0] == "/products/item-1"


def test_selector_preview_reports_invalid_selector(client: TestClient, auth_headers) -> None:
    """A malformed selector must be reported, not silently treated as no match."""
    response = client.post(
        "/v1/selectors/preview",
        json={
            "html": "<html><body><p>x</p></body></html>",
            "selectors": [{"name": "bad", "selector": "///", "selectorType": "xpath"}],
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    probe = response.json()[0]
    assert probe["error"], probe
    assert probe["matches"] == 0


# ---------------------------------------------------------------------------
# SSRF pre-flight
# ---------------------------------------------------------------------------
def test_ssrf_check_endpoint(client: TestClient, auth_headers) -> None:
    response = client.post(
        "/v1/ssrf/check",
        json={"urls": ["https://example.com/ok", "http://169.254.169.254/latest/", "http://localhost:8000/"]},
        headers=auth_headers,
    )
    assert response.status_code == 200
    results = {r["url"]: r for r in response.json()["results"]}
    assert results["https://example.com/ok"]["allowed"] is True
    assert results["http://169.254.169.254/latest/"]["allowed"] is False
    assert results["http://localhost:8000/"]["allowed"] is False


# ---------------------------------------------------------------------------
# AI endpoints degrade cleanly without a provider
# ---------------------------------------------------------------------------
def test_ai_status_reports_not_configured(client: TestClient, auth_headers) -> None:
    body = client.get("/v1/ai/status", headers=auth_headers).json()
    assert body["configured"] is False
    assert body["features"]["heuristicAutoExtract"] is True


def test_ai_config_without_provider_returns_503(client: TestClient, auth_headers) -> None:
    response = client.post(
        "/v1/ai/config",
        json={"prompt": "get all product names and prices"},
        headers=auth_headers,
    )
    assert response.status_code == 503


def test_infer_schema_falls_back_to_heuristics(client: TestClient, auth_headers, sample_listing_html: str) -> None:
    """Schema inference must still return something useful with no AI provider."""
    response = client.post(
        "/v1/ai/infer-schema",
        json={"html": sample_listing_html, "url": "https://shop.example.com/widgets"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is False
    assert body["fallback"]["listSelector"]
    assert body["fallback"]["fields"]


def test_openapi_document_is_valid(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert schema["info"]["title"] == "Webscraper Engine"
    assert "/v1/scrape" in schema["paths"]
