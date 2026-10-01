"""Proxy policy resolution, Decodo URL building and the self-test endpoint."""

from __future__ import annotations

import httpx
import pytest

from app.config import redact, settings
from app.errors import ProxyMisconfigured
from app.fetch.proxies import (
    build_decodo_url,
    normalise_endpoint,
    parse_decodo_spec,
    proxy_health,
    resolve_proxy,
    split_proxy_url,
)

BASE = "acme"
PASSWORD = "s3cr3t-pass"


@pytest.fixture
def decodo_configured(monkeypatch):
    """The engine as it looks with real Decodo credentials in `.env`."""
    monkeypatch.setattr(settings, "decodo_username", f"user-{BASE}", raising=False)
    monkeypatch.setattr(settings, "decodo_password", PASSWORD, raising=False)
    return settings


# ---------------------------------------------------------------------------
# Direct / static / explicit
# ---------------------------------------------------------------------------
def test_direct_when_nothing_is_configured() -> None:
    decision = resolve_proxy(None)
    assert decision.kind == "direct"
    assert decision.url is None
    assert decision.label == "Direct connection"


@pytest.mark.parametrize("policy", ["direct", "none", "off", "", "   "])
def test_direct_aliases(policy: str) -> None:
    assert resolve_proxy(policy).url is None


def test_static_pool_is_used_when_set(monkeypatch) -> None:
    monkeypatch.setattr(settings, "proxy_urls", ["http://10.0.0.1:3128"], raising=False)
    decision = resolve_proxy(None)
    assert decision.kind == "static"
    assert decision.url == "http://10.0.0.1:3128"


def test_explicit_url_passes_through_with_a_warning() -> None:
    decision = resolve_proxy("http://bob:hunter2@proxy.internal:3128")
    assert decision.kind == "explicit"
    assert decision.url == "http://bob:hunter2@proxy.internal:3128"
    # Credentials in a saved job config are a footgun, so the caller is warned.
    assert decision.warnings and "credentials" in decision.warnings[0]


def test_explicit_url_without_credentials_is_quiet() -> None:
    decision = resolve_proxy("socks5://proxy.internal:1080")
    assert decision.kind == "explicit"
    assert decision.warnings == ()


@pytest.mark.parametrize("policy", ["ftp://proxy:21", "file:///etc/passwd", "gate.decodo.com:7000"])
def test_unusable_policies_are_rejected(policy: str) -> None:
    with pytest.raises(ProxyMisconfigured):
        resolve_proxy(policy)


# ---------------------------------------------------------------------------
# Decodo
# ---------------------------------------------------------------------------
def test_bare_decodo_builds_a_rotating_url(decodo_configured) -> None:
    decision = resolve_proxy("decodo")
    assert decision.kind == "decodo"
    assert decision.url is not None
    assert decision.url.startswith(f"http://user-{BASE}:{PASSWORD}@gate.decodo.com:7000")
    assert "rotating IP" in decision.label


def test_decodo_targeting_rides_in_the_username(decodo_configured) -> None:
    url = build_decodo_url(parse_decodo_spec("decodo://?country=us&city=new_york&session=abc123&sticky=10"))
    username = url.split("://", 1)[1].split(":", 1)[0]
    assert username == "user-acme-country-us-city-new_york-session-abc123-sessionduration-10"


def test_dashboard_style_username_is_not_double_prefixed(decodo_configured) -> None:
    assert resolve_proxy("decodo").url.startswith("http://user-acme:")  # not user-user-acme


def test_username_without_a_user_prefix_is_accepted(monkeypatch, decodo_configured) -> None:
    monkeypatch.setattr(settings, "decodo_username", "plainname", raising=False)
    assert resolve_proxy("decodo").url.startswith("http://user-plainname:")


def test_special_characters_in_the_password_are_encoded(monkeypatch, decodo_configured) -> None:
    monkeypatch.setattr(settings, "decodo_password", "p@ss:w/rd%21", raising=False)
    url = resolve_proxy("decodo").url
    # The raw password must not appear unencoded (":", "@" and "/" would break
    # URL parsing and silently corrupt the credential).
    assert "p@ss:w/rd%21@" not in url
    assert "%40" in url and "%3A" in url and "%2F" in url


def test_bare_dashboard_parameter_string_is_understood(decodo_configured) -> None:
    spec = parse_decodo_spec("decodo://country-us-session-abc")
    assert spec.country == "us"
    assert spec.session == "abc"


def test_sticky_without_a_session_is_synthesised_once(decodo_configured) -> None:
    first = build_decodo_url(parse_decodo_spec("decodo://?country=us&sticky=5"))
    second = build_decodo_url(parse_decodo_spec("decodo://?country=us&sticky=5"))
    # A crawl must not bounce between exit IPs on every page.
    assert first == second
    assert "sessionduration-5" in first


@pytest.mark.parametrize(
    "policy",
    [
        "decodo://?country=usa",          # not a 2-letter code
        "decodo://?session=has spaces",
        "decodo://?asn=not-a-number",
        "decodo://?sticky=99999",         # beyond the 24h provider maximum
        "decodo://?sticky=soon",
        "decodo://?contry=us",            # typo'd key
    ],
)
def test_invalid_decodo_options_fail_loudly(policy: str, decodo_configured) -> None:
    with pytest.raises(ProxyMisconfigured):
        resolve_proxy(policy)


def test_unknown_option_lists_the_valid_ones(decodo_configured) -> None:
    with pytest.raises(ProxyMisconfigured) as excinfo:
        resolve_proxy("decodo://?nope=1")
    assert "country" in excinfo.value.details["allowed"]


def test_missing_credentials_name_the_env_vars() -> None:
    with pytest.raises(ProxyMisconfigured) as excinfo:
        resolve_proxy("decodo://?country=us")
    assert set(excinfo.value.details["missing"]) == {"DECODO_USERNAME", "DECODO_PASSWORD"}
    assert excinfo.value.code == "proxy_misconfigured"
    assert excinfo.value.http_status == 400


def test_default_country_from_settings_is_applied(monkeypatch, decodo_configured) -> None:
    monkeypatch.setattr(settings, "decodo_country", "de", raising=False)
    assert "country-de" in resolve_proxy("decodo").url


def test_explicit_country_beats_the_default(monkeypatch, decodo_configured) -> None:
    monkeypatch.setattr(settings, "decodo_country", "de", raising=False)
    assert "country-jp" in resolve_proxy("decodo://?country=jp").url


def test_account_default_country_is_left_alone(decodo_configured) -> None:
    # No country anywhere => Decodo's own default, expressed by omitting the
    # parameter rather than sending `country-any` (which is not a real code).
    assert "country-" not in resolve_proxy("decodo").url


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("gate.decodo.com:7000", "gate.decodo.com:7000"),
        ("http://gate.decodo.com:7000", "gate.decodo.com:7000"),
        ("gate.decodo.com", "gate.decodo.com:7000"),
    ],
)
def test_endpoint_normalisation(raw: str, expected: str) -> None:
    assert normalise_endpoint(raw) == expected


def test_endpoint_override(monkeypatch, decodo_configured) -> None:
    monkeypatch.setattr(settings, "decodo_endpoint", "us.decodo.example:8080", raising=False)
    assert "@us.decodo.example:8080" in resolve_proxy("decodo").url


def test_split_proxy_url_returns_playwright_fields(decodo_configured) -> None:
    proxy = split_proxy_url(resolve_proxy("decodo").url)
    assert proxy == {
        "server": "http://gate.decodo.com:7000",
        "username": "user-acme",
        "password": PASSWORD,
    }


def test_split_proxy_url_without_credentials() -> None:
    assert split_proxy_url("http://proxy.internal:3128") == {"server": "http://proxy.internal:3128"}


def test_proxy_health_never_leaks_credentials(decodo_configured) -> None:
    health = proxy_health()
    assert health["decodo_configured"] is True
    assert health["decodo_endpoint"] == "gate.decodo.com:7000"
    assert PASSWORD not in str(health)
    assert BASE not in str(health)


def test_partial_decodo_credentials_are_flagged(monkeypatch, decodo_configured) -> None:
    monkeypatch.setattr(settings, "decodo_password", None, raising=False)
    assert proxy_health()["decodo_partial_credentials"] is True
    assert any("DECODO_PASSWORD" in warning for warning in settings.startup_warnings())


def test_credential_bearing_urls_are_redacted_in_logs() -> None:
    scrubbed = redact("connecting via http://user-acme:s3cr3t@gate.decodo.com:7000 now")
    assert "s3cr3t" not in scrubbed
    assert "gate.decodo.com:7000" in scrubbed


# ---------------------------------------------------------------------------
# Endpoint
#
# These use a fake httpx client rather than respx on purpose: the thing worth
# asserting is *which proxy URL the engine hands to httpx*, and a mocked
# transport would hide exactly that (respx sees the pre-proxy request).
# ---------------------------------------------------------------------------
class _FakeAsyncClient:
    """Minimal stand-in for httpx.AsyncClient that records its arguments."""

    calls: list[dict[str, object]] = []
    response: httpx.Response = httpx.Response(200, json={})

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        _FakeAsyncClient.calls.append(kwargs)

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def get(self, url: str) -> httpx.Response:
        _FakeAsyncClient.calls[-1]["url"] = url
        return _FakeAsyncClient.response


@pytest.fixture
def fake_http(monkeypatch):
    from app.routers import proxy as proxy_router

    _FakeAsyncClient.calls = []
    _FakeAsyncClient.response = httpx.Response(200, json={})
    monkeypatch.setattr(proxy_router.httpx, "AsyncClient", _FakeAsyncClient)
    yield _FakeAsyncClient
    _FakeAsyncClient.calls = []


def test_proxy_check_without_configuration(client, auth_headers) -> None:
    response = client.post("/v1/proxy/check", json={}, headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["kind"] == "direct"
    assert body["configured"] is False


def test_proxy_check_reports_missing_credentials(client, auth_headers) -> None:
    response = client.post("/v1/proxy/check", json={"policy": "decodo"}, headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "DECODO_USERNAME" in (body["error"] + body["hint"])


def test_proxy_check_requires_authentication(client) -> None:
    assert client.post("/v1/proxy/check", json={}).status_code == 401


def test_proxy_check_routes_through_the_decodo_url(client, auth_headers, decodo_configured, fake_http) -> None:
    fake_http.response = httpx.Response(
        200, json={"ip": "203.0.113.7", "country": "US", "city": "New York", "isp": "Cable Co"}
    )

    response = client.post("/v1/proxy/check", json={"policy": "decodo://?country=us"}, headers=auth_headers)
    assert response.status_code == 200
    body = response.json()

    assert body["ok"] is True
    assert body["kind"] == "decodo"
    assert body["exitIp"] == "203.0.113.7"
    assert body["country"] == "US"
    assert body["endpoint"] == "gate.decodo.com:7000"

    # The engine really did hand the built Decodo URL to httpx, with the
    # country in the username and no credentials left in the response body.
    passed = fake_http.calls[0]["proxy"]
    assert isinstance(passed, str) and "user-acme-country-us" in passed and "gate.decodo.com:7000" in passed
    assert PASSWORD not in response.text


def test_proxy_check_explains_a_407(client, auth_headers, decodo_configured, fake_http) -> None:
    fake_http.response = httpx.Response(407)

    response = client.post("/v1/proxy/check", json={"policy": "decodo"}, headers=auth_headers)
    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is False
    assert "407" in body["error"]
    assert "Proxy setup" in body["hint"]


def test_proxy_check_reports_a_connection_failure(client, auth_headers, decodo_configured, monkeypatch) -> None:
    from app.routers import proxy as proxy_router

    class _Broken(_FakeAsyncClient):
        async def __aenter__(self):
            raise httpx.ProxyError("refused")

    monkeypatch.setattr(proxy_router.httpx, "AsyncClient", _Broken)

    response = client.post("/v1/proxy/check", json={"policy": "decodo"}, headers=auth_headers)
    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is False
    assert "refused the connection" in body["error"]
