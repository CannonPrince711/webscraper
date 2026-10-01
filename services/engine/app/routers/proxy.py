"""Proxy self-test.

`POST /v1/proxy/check` answers the only question that matters after pasting
credentials into `.env`: *is traffic actually leaving through the proxy, and from
where?* It resolves the policy the same way a real fetch would, sends one small
request to an echo service through it, and reports the exit IP.

Deliberate properties:

* **It never returns the credentials.** The resolved URL is used and discarded;
  the response contains the human label and the echo service's answer only.
* **It does not touch the target site.** One request to the provider's own echo
  endpoint — no customer URL, no crawl budget, no robots concern.
* **Failures are data, not exceptions.** A wrong password is a 407 with a clear
  message, not a 500: this endpoint exists to diagnose, so it must never be the
  thing that breaks.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter

from ..config import settings
from ..deps import AuthDep
from ..errors import ProxyMisconfigured
from ..fetch.proxies import normalise_endpoint, proxy_health, resolve_proxy
from ..models import ProxyCheckRequest, ProxyCheckResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["proxy"], prefix="/v1")

#: Echo services that report the caller's IP. Decodo runs its own, which also
#: reports the residential classification; the generic one is the fallback for
#: self-hosted proxies.
_ECHO_ENDPOINTS: dict[str, str] = {
    "decodo": "https://ip.decodo.com/json",
    "default": "https://api.ipify.org?format=json",
}


def _extract_exit(body: Any) -> dict[str, str | None]:
    """Pull the interesting fields out of whichever echo service answered.

    Providers change their response shape without notice, so this reads the two
    or three key names in use and gives up quietly rather than raising.
    """
    if not isinstance(body, dict):
        return {}

    source = body
    for key in ("proxy", "data", "result"):
        if isinstance(body.get(key), dict):
            source = body[key]
            break

    def pick(*names: str) -> str | None:
        for name in names:
            value = source.get(name)
            if isinstance(value, (str, int, float)):
                return str(value)
        return None

    return {
        "exit_ip": pick("ip", "origin", "query"),
        "country": pick("country", "country_code"),
        "city": pick("city"),
        "isp": pick("isp", "org", "provider"),
    }


@router.post("/proxy/check", response_model=ProxyCheckResponse, summary="Test the egress proxy")
async def proxy_check(_: AuthDep, request: ProxyCheckRequest) -> ProxyCheckResponse:
    health = proxy_health()
    policy = request.policy or ("decodo" if health["decodo_configured"] else None)

    started = time.perf_counter()
    try:
        decision = resolve_proxy(policy)
    except ProxyMisconfigured as exc:
        return ProxyCheckResponse(
            ok=False,
            kind="direct",
            label="Not configured",
            configured=health["decodo_configured"],
            duration_ms=round((time.perf_counter() - started) * 1000, 1),
            error=exc.message,
            hint=exc.details.get("hint"),
        )

    # Nothing to test: a direct connection is a valid configuration, and
    # spending a request to prove "the internet works" helps nobody.
    if decision.url is None:
        return ProxyCheckResponse(
            ok=False,
            kind="direct",
            label="Direct connection",
            configured=health["decodo_configured"],
            duration_ms=round((time.perf_counter() - started) * 1000, 1),
            error="No proxy is configured for this policy.",
            hint="Set DECODO_USERNAME and DECODO_PASSWORD, or pass an explicit proxy URL.",
        )

    endpoint = _ECHO_ENDPOINTS["decodo"] if decision.kind == "decodo" else _ECHO_ENDPOINTS["default"]

    try:
        async with httpx.AsyncClient(
            proxy=decision.url,
            timeout=httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0),
            headers={"User-Agent": settings.user_agent, "Accept": "application/json"},
            trust_env=False,
        ) as client:
            response = await client.get(endpoint)
    except httpx.ProxyError as exc:
        return ProxyCheckResponse(
            ok=False,
            kind=decision.kind,
            label=decision.label,
            configured=health["decodo_configured"],
            duration_ms=round((time.perf_counter() - started) * 1000, 1),
            error="The proxy refused the connection. Check the endpoint host, port and credentials.",
            hint=type(exc).__name__,
        )
    except httpx.HTTPError as exc:
        return ProxyCheckResponse(
            ok=False,
            kind=decision.kind,
            label=decision.label,
            configured=health["decodo_configured"],
            duration_ms=round((time.perf_counter() - started) * 1000, 1),
            error="Could not reach the proxy from this host.",
            hint=type(exc).__name__,
        )

    duration_ms = round((time.perf_counter() - started) * 1000, 1)
    status = response.status_code

    if status == 407:
        return ProxyCheckResponse(
            ok=False,
            kind=decision.kind,
            label=decision.label,
            configured=health["decodo_configured"],
            duration_ms=duration_ms,
            error="The proxy rejected the credentials (HTTP 407).",
            hint="Copy the username and password again from Decodo → Residential → Proxy setup. "
            "Passwords are regenerated per user, not per account.",
        )
    if status >= 400:
        return ProxyCheckResponse(
            ok=False,
            kind=decision.kind,
            label=decision.label,
            configured=health["decodo_configured"],
            duration_ms=duration_ms,
            error=f"The proxy returned HTTP {status} while testing.",
        )

    try:
        body = response.json()
    except ValueError:
        body = None

    exit_info = _extract_exit(body)
    logger.info(
        "Proxy self-test completed",
        extra={
            "duration_ms": duration_ms,
            "status_code": status,
            # decision.label only — never the resolved URL.
            "domain": decision.kind,
        },
    )

    return ProxyCheckResponse(
        ok=True,
        kind=decision.kind,
        label=decision.label,
        configured=health["decodo_configured"],
        duration_ms=duration_ms,
        endpoint=normalise_endpoint(settings.decodo_endpoint) if decision.kind == "decodo" else None,
        **exit_info,  # type: ignore[arg-type]
    )
