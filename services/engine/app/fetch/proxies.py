"""Proxy resolution — including managed residential providers (Decodo).

A job's `fetch.proxy` is a **policy**, never a credential. Three forms are
accepted:

======================  ==========================================================
``null`` / ``direct``   Connect directly (or from the static pool, if one is
                        configured in ``ENGINE_PROXY_URLS``).
``http://user:pass@…``  An explicit proxy URL. Fine for a self-hosted Squid or a
                        one-off, but it puts a secret in the saved job config and
                        in every API response that echoes the config back.
``decodo`` /            Decodo residential. The credential is read from the
``decodo://?…``         engine's environment (``DECODO_USERNAME`` /
                        ``DECODO_PASSWORD``) at fetch time, so a saved job — and
                        a shared job, and an exported JSON — contains no secret
                        at all.
======================  ==========================================================

Targeting parameters ride in the *username*, which is Decodo's documented
mechanism, so the same string works for HTTP fetches and for Chromium:

    decodo://?country=us&city=new_york&session=abc123&sticky=10
    → http://user-<user>-country-us-city-new_york-session-abc123-sessionduration-10:<pw>@gate.decodo.com:7000

Everything after ``decodo://`` is optional; a bare ``decodo`` means "a rotating
IP from the account's default country".

**Credentials must never be logged.** The resolved URL contains a password, so
this module only ever emits `label` (a human description) — `ProxyDecision.url`
is passed straight to httpx/Playwright and never formatted into a log line. The
redaction filter in `app.config` also scrubs ``scheme://user:pass@`` patterns as
a second line of defence.
"""

from __future__ import annotations

import random
import re
import secrets
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import parse_qsl, quote, urlsplit

from ..config import settings
from ..errors import ProxyMisconfigured

ProxyKind = Literal["direct", "static", "explicit", "decodo"]

#: Keys accepted in the ``decodo://?…`` query string. Anything else is a typo
#: and fails loudly rather than silently scraping from the wrong country.
_DECODO_KEYS: tuple[str, ...] = (
    "country", "city", "state", "continent", "asn", "zip", "geohash",
    "session", "sticky",
)

_COUNTRY_RE = re.compile(r"^[a-z]{2}$")
_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_SIMPLE_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
_ASN_RE = re.compile(r"^\d{1,10}$")
_ZIP_RE = re.compile(r"^[A-Za-z0-9_-]{1,12}$")
_GEOHASH_RE = re.compile(r"^[0-9b-hjkmnp-z]{1,12}$")

#: Session ids invented for a `sticky=` request without an explicit `session=`.
#: Cached per process so a crawl keeps one exit IP instead of bouncing between
#: addresses on every page.
_synthesised_sessions: dict[str, str] = {}


@dataclass(frozen=True)
class ProxyDecision:
    """The resolved egress for one request."""

    kind: ProxyKind
    #: Full proxy URL **including credentials** — never log or serialise this.
    url: str | None
    #: Human-readable description, safe to log, store and show in the UI.
    label: str
    warnings: tuple[str, ...] = field(default=())

    @property
    def to_public(self) -> dict[str, Any]:
        return {"kind": self.kind, "label": self.label, "warnings": list(self.warnings)}


# ---------------------------------------------------------------------------
# Decodo
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DecodoSpec:
    country: str | None = None
    city: str | None = None
    state: str | None = None
    continent: str | None = None
    asn: str | None = None
    zip_code: str | None = None
    geohash: str | None = None
    session: str | None = None
    sticky_minutes: int | None = None

    def parameters(self) -> list[str]:
        """The `-key-value` fragments appended to the proxy username."""
        parts: list[str] = []
        if self.country:
            parts += ["country", self.country]
        if self.city:
            parts += ["city", self.city]
        if self.state:
            parts += ["state", self.state]
        if self.continent:
            parts += ["continent", self.continent]
        if self.asn:
            parts += ["asn", self.asn]
        if self.zip_code:
            parts += ["zip", self.zip_code]
        if self.geohash:
            parts += ["geohash", self.geohash]
        if self.session:
            parts += ["session", self.session]
        if self.sticky_minutes:
            parts += ["sessionduration", str(self.sticky_minutes)]
        return parts

    def label(self) -> str:
        bits = ["Decodo residential"]
        if self.country:
            bits.append(self.country.upper())
        if self.city:
            bits.append(self.city.replace("_", " ").title())
        else:
            if self.state:
                bits.append(self.state.title())
        if self.continent:
            bits.append(f"{self.continent.upper()} continent")
        if self.asn:
            bits.append(f"AS{self.asn}")
        if self.session:
            bits.append(f"sticky {self.sticky_minutes or settings.decodo_session_minutes}m")
        else:
            bits.append("rotating IP")
        return " · ".join(bits)


def parse_decodo_spec(raw: str) -> DecodoSpec:
    """Parse the part after ``decodo://`` into validated parameters."""
    # "decodo", "decodo://", "decodo://?x=1" and "decodo/?x=1" must all parse.
    spec = re.sub(r"^[:/]*", "", raw[len("decodo") :]).lstrip("?")

    values: dict[str, str] = {}
    if spec:
        # Tolerate both `?country=us&session=abc` and the bare
        # `country-us-session-abc` form people copy out of the dashboard.
        if "=" in spec:
            for key, value in parse_qsl(spec, keep_blank_values=False):
                if key not in _DECODO_KEYS:
                    raise ProxyMisconfigured(
                        f"Unknown Decodo option '{key}'.",
                        details={"allowed": list(_DECODO_KEYS)},
                    )
                values[key] = value.strip().lower()
        else:
            tokens = [token for token in re.split(r"[-_]", spec) if token]
            index = 0
            while index < len(tokens) - 1:
                key, value = tokens[index], tokens[index + 1]
                if key not in _DECODO_KEYS:
                    raise ProxyMisconfigured(
                        f"Unknown Decodo option '{key}'.",
                        details={"allowed": list(_DECODO_KEYS)},
                    )
                values[key] = value.strip().lower()
                index += 2

    country = values.get("country") or (settings.decodo_country or "").lower() or None
    if country and country != "any" and not _COUNTRY_RE.match(country):
        raise ProxyMisconfigured(
            "Decodo country must be a two-letter ISO code (e.g. 'us').",
            details={"received": country[:8]},
        )

    def checked(name: str, pattern: re.Pattern[str], hint: str) -> str | None:
        value = values.get(name)
        if value is None:
            return None
        if not pattern.match(value):
            raise ProxyMisconfigured(f"Decodo {name} is invalid — {hint}.")
        return value

    sticky_raw = values.get("sticky")
    sticky_minutes: int | None = None
    if sticky_raw is not None:
        if sticky_raw in {"1", "true", "yes", "on"}:
            sticky_minutes = settings.decodo_session_minutes
        elif sticky_raw in {"0", "false", "no", "off"}:
            sticky_minutes = None
        else:
            try:
                sticky_minutes = int(sticky_raw)
            except ValueError as exc:
                raise ProxyMisconfigured(
                    "Decodo 'sticky' must be a number of minutes (or 1).",
                    details={"received": sticky_raw[:8]},
                ) from exc
            if not 1 <= sticky_minutes <= 1440:
                raise ProxyMisconfigured("Decodo sticky sessions last between 1 and 1440 minutes.")

    return DecodoSpec(
        country=country,
        city=checked("city", _SIMPLE_RE, "lowercase, spaces as underscores, e.g. new_york"),
        state=checked("state", _SIMPLE_RE, "e.g. us_new_york"),
        continent=checked("continent", _SIMPLE_RE, "e.g. eu"),
        asn=checked("asn", _ASN_RE, "digits only, e.g. 20057"),
        zip_code=checked("zip", _ZIP_RE, "letters, digits, hyphen or underscore"),
        geohash=checked("geohash", _GEOHASH_RE, "a geohash, e.g. dr5r"),
        session=checked("session", _SESSION_RE, "letters, digits, '-' or '_', up to 32 chars"),
        sticky_minutes=sticky_minutes,
    )


def build_decodo_url(spec: DecodoSpec, *, endpoint: str | None = None) -> str:
    """Build the proxy URL, or explain precisely which setting is missing."""
    username = (settings.decodo_username or "").strip()
    password = settings.decodo_password or ""

    if not username or not password:
        raise ProxyMisconfigured(
            "This job is configured to use Decodo proxies, but the engine has no Decodo credentials.",
            details={
                "hint": "Set DECODO_USERNAME and DECODO_PASSWORD (Decodo dashboard → Residential → Proxy setup).",
                "missing": [name for name, value in (("DECODO_USERNAME", username), ("DECODO_PASSWORD", password)) if not value],
            },
        )

    # The dashboard shows the username as `user-xxxx`; accept either form.
    base = username[5:] if username.startswith("user-") else username

    if not spec.session and spec.sticky_minutes:
        key = f"{base}|{spec.country}|{spec.city}|{spec.sticky_minutes}"
        if key not in _synthesised_sessions:
            _synthesised_sessions[key] = f"ws{secrets.token_hex(6)}"
        spec = DecodoSpec(**{**spec.__dict__, "session": _synthesised_sessions[key]})

    user = "-".join(["user", base, *spec.parameters()])
    host = normalise_endpoint(endpoint or settings.decodo_endpoint)
    return f"http://{quote(user, safe='-')}:{quote(password, safe='')}@{host}"


def normalise_endpoint(endpoint: str) -> str:
    """`gate.decodo.com:7000`, `http://gate.decodo.com:7000` → `gate.decodo.com:7000`."""
    candidate = endpoint.strip()
    if "://" in candidate:
        parts = urlsplit(candidate)
        host = parts.hostname or "gate.decodo.com"
        port = parts.port or 7000
        return f"{host}:{port}"
    if ":" not in candidate:
        return f"{candidate}:7000"
    return candidate


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------
def resolve_proxy(policy: str | None, *, now: float | None = None) -> ProxyDecision:
    """Turn a job's proxy policy into something httpx and Chromium can use."""
    del now  # reserved for time-bucketed session strategies
    raw = (policy or "").strip()

    if not raw or raw.lower() in {"direct", "none", "off"}:
        if settings.proxy_urls:
            return ProxyDecision(
                kind="static",
                url=random.choice(settings.proxy_urls),
                label=f"Static pool ({len(settings.proxy_urls)} endpoint(s))",
            )
        return ProxyDecision(kind="direct", url=None, label="Direct connection")

    lowered = raw.lower()
    if lowered == "decodo" or lowered.startswith("decodo:"):
        return ProxyDecision(
            kind="decodo",
            url=build_decodo_url(parse_decodo_spec(raw)),
            label=parse_decodo_spec(raw).label(),
        )

    if "://" in raw:
        parts = urlsplit(raw)
        if parts.scheme not in {"http", "https", "socks5", "socks5h"}:
            raise ProxyMisconfigured(
                "Proxy URLs must use http, https or socks5.",
                details={"received_scheme": parts.scheme[:12]},
            )
        if not parts.hostname:
            raise ProxyMisconfigured("That proxy URL has no host.")
        warnings: tuple[str, ...] = ()
        if parts.password:
            warnings = (
                "This job stores proxy credentials in its configuration. "
                "Prefer the 'decodo' policy, which reads them from the server environment.",
            )
        return ProxyDecision(kind="explicit", url=raw, label="Custom proxy", warnings=warnings)

    raise ProxyMisconfigured(
        "Unrecognised proxy setting. Use 'decodo', a proxy URL, or leave it empty for a direct connection.",
        details={"received": raw[:40]},
    )


def split_proxy_url(url: str) -> dict[str, str]:
    """Split a proxy URL for Playwright, which takes server/user/pass separately."""
    parts = urlsplit(url)
    server = f"{parts.scheme}://{parts.hostname}"
    if parts.port:
        server += f":{parts.port}"
    proxy: dict[str, str] = {"server": server}
    if parts.username:
        proxy["username"] = parts.username
    if parts.password:
        proxy["password"] = parts.password
    return proxy


def proxy_health() -> dict[str, Any]:
    """Capability report for `/readyz`. Never includes credentials."""
    decodo_configured = bool(settings.decodo_username and settings.decodo_password)
    partially_configured = bool(settings.decodo_username) != bool(settings.decodo_password)
    return {
        "static_pool_size": len(settings.proxy_urls),
        "decodo_configured": decodo_configured,
        "decodo_endpoint": normalise_endpoint(settings.decodo_endpoint),
        "decodo_default_country": (settings.decodo_country or "any").lower(),
        "decodo_partial_credentials": partially_configured,
    }
