"""SSRF protection — the single most important control in this service.

The engine's whole job is "make an HTTP request to a URL somebody else chose".
Every URL is therefore treated as hostile until this module clears it, and the
clearance is re-checked on every redirect hop.

Attack classes defended against:

* **Direct** — ``http://127.0.0.1:8000``, ``http://[::1]/``, ``169.254.169.254``.
* **Obfuscated literals** — decimal (``2130706433``), hex (``0x7f000001``),
  octal (``0177.0.0.1``), shortened (``127.1``). These resolve to loopback in
  most HTTP stacks but are *not* valid `ipaddress` literals, so they are parsed
  explicitly by `_parse_obfuscated_ip`.
* **DNS rebinding (TOCTOU)** — a name resolves to a public IP during validation
  and a private one when the socket is opened. Mitigated by resolving once,
  validating *all* answers, and pinning the connection to the validated IP
  (see `fetch/http.py::build_pinned_request`).
* **IPv6 smuggling** — IPv4-mapped (``::ffff:127.0.0.1``) and 6to4
  (``2002:7f00:1::``) forms that carry a private v4 address inside a v6 one.
* **Redirect escape** — a public URL that 302s to a private one; redirects are
  never auto-followed and each ``Location`` restarts validation.
* **Credential smuggling** — ``http://user:pass@host`` and control characters
  in the host, used to confuse parsers elsewhere in the chain.

The guard is intentionally cheap (no network calls beyond DNS) and is used in
three places: request validation, per-redirect validation, and the link
frontier before a URL is queued.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from urllib.parse import SplitResult, quote, urlsplit, urlunsplit

from ..config import settings
from ..errors import SSRFBlocked

# ---------------------------------------------------------------------------
# Policy tables
# ---------------------------------------------------------------------------
BLOCKED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    # IPv4
    ipaddress.ip_network("0.0.0.0/8"),        # "this network"
    ipaddress.ip_network("10.0.0.0/8"),       # RFC1918
    ipaddress.ip_network("100.64.0.0/10"),    # CGNAT
    ipaddress.ip_network("127.0.0.0/8"),      # loopback
    ipaddress.ip_network("169.254.0.0/16"),   # link-local + cloud metadata
    ipaddress.ip_network("172.16.0.0/12"),    # RFC1918
    ipaddress.ip_network("192.0.0.0/24"),     # IETF protocol assignments
    ipaddress.ip_network("192.0.2.0/24"),     # TEST-NET-1
    ipaddress.ip_network("192.88.99.0/24"),   # 6to4 relay anycast
    ipaddress.ip_network("192.168.0.0/16"),   # RFC1918
    ipaddress.ip_network("198.18.0.0/15"),    # benchmarking
    ipaddress.ip_network("198.51.100.0/24"),  # TEST-NET-2
    ipaddress.ip_network("203.0.113.0/24"),   # TEST-NET-3
    ipaddress.ip_network("224.0.0.0/4"),      # multicast
    ipaddress.ip_network("240.0.0.0/4"),      # reserved
    ipaddress.ip_network("255.255.255.255/32"),
    # IPv6
    ipaddress.ip_network("::/128"),           # unspecified
    ipaddress.ip_network("::1/128"),          # loopback
    ipaddress.ip_network("::ffff:0:0/96"),    # IPv4-mapped
    ipaddress.ip_network("64:ff9b::/96"),     # NAT64
    ipaddress.ip_network("100::/64"),         # discard-only
    ipaddress.ip_network("2001::/23"),        # IETF protocol assignments
    ipaddress.ip_network("2001:db8::/32"),    # documentation
    ipaddress.ip_network("2002::/16"),        # 6to4 (tunnels private v4)
    ipaddress.ip_network("fc00::/7"),         # unique local
    ipaddress.ip_network("fe80::/10"),        # link-local
    ipaddress.ip_network("ff00::/8"),         # multicast
)

# Hostnames that are internal by convention regardless of what DNS says.
BLOCKED_HOST_SUFFIXES: tuple[str, ...] = (
    "localhost",
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".intranet",
    ".corp",
    ".home",
    ".home.arpa",
    ".lan",
    ".private",
    ".test",
    ".example",
    ".invalid",
    ".cluster.local",
    ".svc",
    ".svc.cluster.local",
    ".in-addr.arpa",
    ".ip6.arpa",
)

BLOCKED_HOST_EXACT: frozenset[str] = frozenset(
    {
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
        "169.254.169.254",
        "fd00:ec2::254",  # AWS IMDS over IPv6
        "kubernetes",
        "kubernetes.default",
        "kubernetes.default.svc",
        "host.docker.internal",
        "gateway.docker.internal",
        "redis",
        "db",
        "postgres",
        "engine",
        "worker",
        "web",
    }
)

# Characters that must never appear in a hostname: they are used to desync
# parsers between our validation and the socket layer.
_FORBIDDEN_HOST_CHARS = re.compile(r"[\s\x00-\x1f\x7f\"'<>\\^`{|}#/@?]")

_HEX = re.compile(r"^0[xX][0-9a-fA-F]+$")
_DECIMAL = re.compile(r"^\d+$")
_OCTAL_PART = re.compile(r"^0[0-7]*$")

MAX_URL_LENGTH = 4096


@dataclass(slots=True)
class ValidatedTarget:
    """A URL that survived validation, plus the facts needed to connect safely."""

    url: str
    scheme: str
    host: str              # normalised hostname, no brackets, lowercase, IDNA
    port: int
    resolved_ips: list[str] = field(default_factory=list)
    pinned_ip: str | None = None

    @property
    def host_header(self) -> str:
        default = 443 if self.scheme == "https" else 80
        return self.host if self.port == default else f"{self.host}:{self.port}"

    @property
    def origin(self) -> str:
        default = 443 if self.scheme == "https" else 80
        netloc = self.host if self.port == default else f"{self.host}:{self.port}"
        return f"{self.scheme}://{netloc}"

    @property
    def registrable_hint(self) -> str:
        """Best-effort registrable domain (last two labels) for scope checks."""
        parts = self.host.split(".")
        if len(parts) <= 2:
            return self.host
        # Handles the common two-level public suffixes without a PSL dependency.
        if parts[-2] in {"co", "com", "org", "net", "gov", "edu", "ac"} and len(parts) >= 3:
            return ".".join(parts[-3:])
        return ".".join(parts[-2:])


# ---------------------------------------------------------------------------
# IP classification
# ---------------------------------------------------------------------------
def is_blocked_ip(ip: str | ipaddress._BaseAddress) -> bool:
    """True when an address must never be reachable from the engine."""
    try:
        addr = ip if isinstance(ip, (ipaddress.IPv4Address, ipaddress.IPv6Address)) else ipaddress.ip_address(ip)
    except ValueError:
        return True  # unparseable => treat as hostile

    # Unwrap anything that carries a v4 address inside a v6 one.
    if isinstance(addr, ipaddress.IPv6Address):
        for candidate in (
            addr,
            getattr(addr, "ipv4_mapped", None),
            getattr(addr, "sixtofour", None),
            getattr(addr, "teredo", None)[1] if getattr(addr, "teredo", None) else None,
        ):
            if candidate is None:
                continue
            if isinstance(candidate, (ipaddress.IPv4Address, ipaddress.IPv6Address)) and _in_blocked(candidate):
                return True
        return _in_blocked(addr)

    if _in_blocked(addr):
        return True
    # Also reject any address that is not globally routable per the stdlib.
    return not addr.is_global


def _in_blocked(addr: ipaddress._BaseAddress) -> bool:
    for network in BLOCKED_NETWORKS:
        if addr.version == network.version and addr in network:
            return True
    return False


def _parse_obfuscated_ip(host: str) -> str | None:
    """Decode integer/hex/octal/short forms of an IPv4 literal.

    ``2130706433``, ``0x7f000001``, ``017700000001``, ``127.1`` and
    ``0177.0.0.1`` all mean 127.0.0.1 to a resolver, but `ipaddress` rejects
    them. This returns the canonical dotted form, or None if it is a normal
    hostname.
    """
    raw = host.strip().strip("[]")
    if not raw:
        return None

    # Single integer in decimal / hex / octal.
    if _DECIMAL.match(raw) or _HEX.match(raw):
        try:
            value = int(raw, 0)
        except ValueError:
            return None
        if 0 <= value <= 0xFFFFFFFF:
            return str(ipaddress.IPv4Address(value))
        return None

    # Dotted form with 1–4 parts, any of which may be octal/hex.
    if "." in raw:
        parts = raw.split(".")
        if not all(parts) or len(parts) > 4:
            return None
        # A dotted form containing a hex part is still numeric (e.g. 0x7f.0.0.1).
        if not all(_DECIMAL.match(p) or _HEX.match(p) or _OCTAL_PART.match(p) for p in parts):
            return None
        try:
            numbers = [int(p, 0 if (p.startswith("0x") or _HEX.match(p)) else (8 if p.startswith("0") and len(p) > 1 else 10)) for p in parts]
        except ValueError:
            return None
        # inet_aton semantics: the last part fills the remaining octets.
        if len(parts) == 1:
            value = numbers[0]
        elif len(parts) == 2:
            value = (numbers[0] << 24) | numbers[1]
        elif len(parts) == 3:
            value = (numbers[0] << 24) | (numbers[1] << 16) | numbers[2]
        else:
            value = (numbers[0] << 24) | (numbers[1] << 16) | (numbers[2] << 8) | numbers[3]
        if 0 <= value <= 0xFFFFFFFF:
            return str(ipaddress.IPv4Address(value))
    return None


# ---------------------------------------------------------------------------
# URL parsing
# ---------------------------------------------------------------------------
def normalize_host(host: str) -> str:
    """Lowercase, IDNA-encode, and sanity-check a hostname."""
    if not host:
        raise SSRFBlocked("URL has no host", details={"reason": "empty_host"})

    host = unicodedata.normalize("NFKC", host).strip().rstrip(".")

    if _FORBIDDEN_HOST_CHARS.search(host):
        raise SSRFBlocked("Host contains forbidden characters", details={"reason": "host_charset"})

    # IPv6 literals keep their brackets stripped and are validated as addresses.
    if ":" in host:
        try:
            return str(ipaddress.IPv6Address(host.strip("[]")))
        except ValueError as exc:
            raise SSRFBlocked("Malformed IPv6 literal", details={"reason": "bad_ipv6"}) from exc

    try:
        host = host.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError) as exc:
        raise SSRFBlocked("Invalid internationalised hostname", details={"reason": "idna"}) from exc

    if len(host) > 253:
        raise SSRFBlocked("Hostname too long", details={"reason": "host_length"})

    for label in host.split("."):
        if not label or len(label) > 63:
            raise SSRFBlocked("Invalid hostname label", details={"reason": "label_length"})
        if not re.fullmatch(r"[a-z0-9_-]+", label):
            raise SSRFBlocked("Invalid hostname characters", details={"reason": "label_charset"})
        if label.startswith("-") or label.endswith("-"):
            raise SSRFBlocked("Invalid hostname label", details={"reason": "label_hyphen"})

    return host


def _is_blocked_hostname(host: str) -> tuple[bool, str]:
    if host in BLOCKED_HOST_EXACT:
        return True, "blocked_host"
    for suffix in BLOCKED_HOST_SUFFIXES:
        if host == suffix.lstrip(".") or host.endswith(suffix):
            return True, f"blocked_suffix:{suffix}"
    # Bare single-label hosts are internal by definition (no public TLD).
    if "." not in host and ":" not in host:
        return True, "single_label_host"
    return False, ""


def parse_and_validate_url(url: str, *, allow_private: bool | None = None) -> ValidatedTarget:
    """Validate a URL *without* doing DNS. Used for cheap frontier filtering."""
    if not url or len(url) > MAX_URL_LENGTH:
        raise SSRFBlocked("URL is empty or too long", details={"reason": "url_length"})

    candidate = url.strip()
    if any(ord(ch) < 0x20 for ch in candidate):
        raise SSRFBlocked("URL contains control characters", details={"reason": "control_chars"})

    # A scheme-less input is assumed to be https rather than silently http.
    if "://" not in candidate:
        candidate = "https://" + candidate

    try:
        parts: SplitResult = urlsplit(candidate)
    except ValueError as exc:
        raise SSRFBlocked("URL could not be parsed", details={"reason": "unparseable"}) from exc

    scheme = parts.scheme.lower()
    if scheme not in {"http", "https"}:
        raise SSRFBlocked(
            f"Scheme '{scheme}' is not allowed", details={"reason": "scheme", "scheme": scheme}
        )
    if scheme == "http" and not settings.allow_http_scheme:
        raise SSRFBlocked("Plain HTTP is disabled", details={"reason": "http_disabled"})

    if parts.username or parts.password:
        raise SSRFBlocked("Credentials in the URL are not allowed", details={"reason": "userinfo"})

    host = normalize_host(parts.hostname or "")

    try:
        port = parts.port
    except ValueError as exc:
        raise SSRFBlocked("Invalid port", details={"reason": "port"}) from exc
    port = port or (443 if scheme == "https" else 80)
    if port not in settings.allowed_ports:
        raise SSRFBlocked(
            f"Port {port} is not allowed",
            details={"reason": "port", "allowed": settings.allowed_ports},
        )

    effective_allow_private = settings.allow_private_networks if allow_private is None else allow_private
    if not effective_allow_private:
        blocked, reason = _is_blocked_hostname(host)
        if blocked:
            raise SSRFBlocked(
                f"Refusing to fetch internal host '{host}'",
                details={"reason": reason, "host": host},
            )

        obfuscated = _parse_obfuscated_ip(host)
        literal = obfuscated or host
        try:
            addr = ipaddress.ip_address(literal)
        except ValueError:
            addr = None  # a normal DNS name — checked again after resolution
        if addr is not None and is_blocked_ip(addr):
            raise SSRFBlocked(
                "Refusing to fetch a private, loopback or reserved address",
                details={"reason": "ip_literal", "host": host, "address": str(addr)},
            )

    # Rebuild the URL from validated parts: drops any parser-confusing extras
    # (fragments, duplicate slashes in the authority) before it reaches a socket.
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=~-._")
    query = quote(parts.query, safe="=&?/:@!$'()*+,;~-._%[]")
    netloc = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    if port != default_port:
        netloc = f"{netloc}:{port}"
    clean = urlunsplit((scheme, netloc, path, query, ""))

    return ValidatedTarget(url=clean, scheme=scheme, host=host, port=port)


async def resolve_host(host: str) -> list[str]:
    """Resolve A/AAAA records. Returns an empty list when nothing resolves."""
    import asyncio

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        return []
    seen: list[str] = []
    for info in infos:
        ip = info[4][0]
        if ip not in seen:
            seen.append(ip)
    return seen


async def validate_url(url: str, *, allow_private: bool | None = None, resolve: bool = True) -> ValidatedTarget:
    """Full validation: shape, then DNS, then every resolved address.

    The returned `pinned_ip` is the address the fetcher must connect to, which
    closes the DNS-rebinding window between validation and connection.
    """
    target = parse_and_validate_url(url, allow_private=allow_private)
    effective_allow_private = settings.allow_private_networks if allow_private is None else allow_private

    if effective_allow_private:
        return target

    # A validating pass over the literal again, in case the host *was* an IP.
    literal = _parse_obfuscated_ip(target.host) or target.host
    try:
        addr = ipaddress.ip_address(literal)
        if is_blocked_ip(addr):
            raise SSRFBlocked("Blocked address", details={"reason": "ip_literal"})
        target.resolved_ips = [str(addr)]
        target.pinned_ip = str(addr)
        return target
    except ValueError:
        pass  # not a literal — resolve below

    ips = await resolve_host(target.host)
    if not ips:
        raise SSRFBlocked(
            "Hostname did not resolve",
            details={"reason": "dns_failure", "host": target.host},
        )

    # Every answer must be public: a split-horizon/round-robin record that
    # returns one private address is a rebinding attempt, not a coincidence.
    for ip in ips:
        if is_blocked_ip(ip):
            raise SSRFBlocked(
                "Hostname resolves to a private, loopback or reserved address",
                details={"reason": "dns_private", "host": target.host, "address": ip},
            )

    # IPv4 first: fewer broken middleboxes than happy-eyeballs from a datacentre.
    ordered = sorted(ips, key=lambda a: ":" in a)
    target.resolved_ips = ordered
    target.pinned_ip = ordered[0] if settings.pin_resolved_ip else None
    return target


def assert_url_allowed(url: str, *, allow_private: bool | None = None) -> ValidatedTarget:
    """Synchronous, DNS-free check for frontier filtering (crawl links)."""
    return parse_and_validate_url(url, allow_private=allow_private)


def is_url_in_scope(
    url: str,
    *,
    allowed_hosts: Iterable[str],
    same_domain: bool = True,
    registrable: str | None = None,
) -> bool:
    """Crawl-scope test. Cheap and DNS-free, so it can run on every link."""
    try:
        target = parse_and_validate_url(url)
    except SSRFBlocked:
        return False

    hosts = {h.lower() for h in allowed_hosts}
    if target.host in hosts or ("www." + target.host) in hosts or target.host.removeprefix("www.") in hosts:
        return True
    if same_domain and registrable:
        return target.registrable_hint == registrable
    return False
