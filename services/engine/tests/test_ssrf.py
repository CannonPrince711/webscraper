"""SSRF guard tests — the highest-value suite in the repository.

Each case is a real-world bypass technique. A regression here is a cloud
credential leak, so these tests are intentionally adversarial rather than
illustrative.
"""

from __future__ import annotations

import pytest

from app.core.ssrf import (
    assert_url_allowed,
    is_blocked_ip,
    is_url_in_scope,
    normalize_host,
    parse_and_validate_url,
    validate_url,
)
from app.errors import SSRFBlocked

# ---------------------------------------------------------------------------
# Blocked address space
# ---------------------------------------------------------------------------
BLOCKED_IPS = [
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.1.2.3", "172.16.5.5", "192.168.1.1",
    "169.254.169.254",      # AWS/GCP/Azure IMDS
    "100.100.100.200",      # Alibaba Cloud metadata
    "100.64.0.1",           # CGNAT
    "198.18.0.1",           # benchmarking range
    "224.0.0.1",            # multicast
    "255.255.255.255",
    "::1", "::", "fc00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1",     # IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "2002:7f00:1::",        # 6to4 tunnelling 127.0.0.1
    "64:ff9b::7f00:1",      # NAT64 loopback
    "2001:db8::1",          # documentation range
    "fd00:ec2::254",        # AWS IMDS over IPv6
]

PUBLIC_IPS = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]


@pytest.mark.parametrize("ip", BLOCKED_IPS)
def test_blocked_ips_are_rejected(ip: str) -> None:
    assert is_blocked_ip(ip) is True, f"{ip} should be blocked"


@pytest.mark.parametrize("ip", PUBLIC_IPS)
def test_public_ips_are_allowed(ip: str) -> None:
    assert is_blocked_ip(ip) is False, f"{ip} should be allowed"


def test_unparseable_address_treated_as_blocked() -> None:
    assert is_blocked_ip("not-an-ip") is True


# ---------------------------------------------------------------------------
# Blocked hostnames
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "host",
    [
        "localhost", "localhost.", "metadata.google.internal", "metadata.goog",
        "instance-data", "kubernetes.default.svc", "foo.internal", "db.local",
        "service.cluster.local", "app.intranet", "thing.corp", "redis", "engine",
        "host.docker.internal", "gateway.docker.internal",
    ],
)
def test_blocked_hostnames(host: str) -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed(f"http://{host}/path")


@pytest.mark.parametrize("host", ["single", "just-a-word"])
def test_single_label_hosts_blocked(host: str) -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed(f"http://{host}/")


# ---------------------------------------------------------------------------
# Obfuscated literals — the classic bypass class
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url",
    [
        "http://2130706433/",            # decimal 127.0.0.1
        "http://0x7f000001/",            # hex 127.0.0.1
        "http://017700000001/",          # octal 127.0.0.1
        "http://127.1/",                 # short form
        "http://0x7f.0.0.1/",            # mixed hex
        "http://2852039166/",            # decimal 169.254.169.254
        "http://0251.0376.0251.0376/",   # octal dotted 169.254.169.254
        "http://[::ffff:0x7f000001]/",   # hex inside IPv6
    ],
)
def test_obfuscated_ip_literals_blocked(url: str) -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed(url)


# ---------------------------------------------------------------------------
# Scheme, port, credentials and charset
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/x",
     "javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
     "dict://example.com:11211/"],
)
def test_non_http_schemes_rejected(url: str) -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed(url)


@pytest.mark.parametrize("url", ["http://example.com:22/", "http://example.com:6379/", "http://example.com:9200/"])
def test_disallowed_ports_rejected(url: str) -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed(url)


def test_credentials_in_url_rejected() -> None:
    with pytest.raises(SSRFBlocked) as exc:
        assert_url_allowed("https://user:password@example.com/")
    assert exc.value.details["reason"] == "userinfo"


def test_host_header_injection_attempt_rejected() -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed("http://example.com\r\nX-Injected: 1/")


def test_url_without_scheme_defaults_to_https() -> None:
    target = assert_url_allowed("example.com/page")
    assert target.scheme == "https"
    assert target.url.startswith("https://example.com/page")


def test_url_too_long_rejected() -> None:
    with pytest.raises(SSRFBlocked):
        assert_url_allowed("https://example.com/" + "a" * 5000)


# ---------------------------------------------------------------------------
# DNS-level attacks
# ---------------------------------------------------------------------------
async def test_hostname_resolving_to_private_ip_rejected(monkeypatch) -> None:
    from app.core import ssrf

    async def _resolve(_host: str) -> list[str]:
        return ["127.0.0.1"]

    monkeypatch.setattr(ssrf, "resolve_host", _resolve)
    with pytest.raises(SSRFBlocked) as exc:
        await validate_url("https://evil.example.com/")
    assert exc.value.details["reason"] == "dns_private"


async def test_split_horizon_dns_rejected(monkeypatch) -> None:
    """One public answer among private ones is an attack, not a coincidence."""
    from app.core import ssrf

    async def _resolve(_host: str) -> list[str]:
        return ["93.184.216.34", "10.0.0.5"]

    monkeypatch.setattr(ssrf, "resolve_host", _resolve)
    with pytest.raises(SSRFBlocked):
        await validate_url("https://rebind.example.com/")


async def test_unresolvable_hostname_rejected(monkeypatch) -> None:
    from app.core import ssrf

    async def _resolve(_host: str) -> list[str]:
        return []

    monkeypatch.setattr(ssrf, "resolve_host", _resolve)
    with pytest.raises(SSRFBlocked) as exc:
        await validate_url("https://nx.example.com/")
    assert exc.value.details["reason"] == "dns_failure"


async def test_public_hostname_is_pinned(monkeypatch) -> None:
    from app.core import ssrf

    monkeypatch.setattr(ssrf.settings, "pin_resolved_ip", True, raising=False)

    async def _resolve(_host: str) -> list[str]:
        # IPv6 first in the resolver's answer, as a happy-eyeballs host would.
        return ["2606:4700:4700::1111", "93.184.216.35", "93.184.216.34"]

    monkeypatch.setattr(ssrf, "resolve_host", _resolve)
    target = await validate_url("https://example.com/a")

    # IPv4 is preferred for the pinned connection (fewer broken middleboxes from
    # a datacentre), and pinning keeps the resolver's own ordering within a family.
    assert target.pinned_ip == "93.184.216.35"
    assert target.resolved_ips == ["93.184.216.35", "93.184.216.34", "2606:4700:4700::1111"]
    # The Host header keeps the original name so virtual hosting still works.
    assert target.host_header == "example.com"


# ---------------------------------------------------------------------------
# Scope helpers
# ---------------------------------------------------------------------------
def test_scope_allows_same_host_and_subdomains() -> None:
    assert is_url_in_scope("https://example.com/page", allowed_hosts={"example.com"})
    assert is_url_in_scope("https://www.example.com/page", allowed_hosts={"example.com"})


def test_scope_rejects_other_hosts() -> None:
    assert not is_url_in_scope("https://evil.com/page", allowed_hosts={"example.com"})


def test_scope_rejects_blocked_targets_even_if_in_host_list() -> None:
    assert not is_url_in_scope("http://169.254.169.254/", allowed_hosts={"169.254.169.254"})


# ---------------------------------------------------------------------------
# Parsing edge cases
# ---------------------------------------------------------------------------
def test_normalize_host_is_idna_encoded() -> None:
    assert normalize_host("ExAmPle.COM.") == "example.com"
    assert normalize_host("bücher.example") == "xn--bcher-kva.example"


def test_fragment_and_tracking_are_stripped_from_validated_url() -> None:
    target = parse_and_validate_url("https://example.com/p?a=1#section")
    assert "#" not in target.url


def test_localhost_variations_blocked() -> None:
    for variation in ("http://localhost/x", "http://LOCALHOST./x", "http://localhost:8080/x"):
        with pytest.raises(SSRFBlocked):
            assert_url_allowed(variation)
