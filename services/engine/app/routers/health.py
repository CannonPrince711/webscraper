"""Health and readiness.

Two distinct endpoints, because they answer different questions:

* `/healthz` — "is the process alive?" Never touches the network or Redis, so a
  slow dependency cannot make an orchestrator kill a healthy pod.
* `/readyz` — "can it serve traffic?" Checks the optional dependencies and
  reports them, but only *fails* on things that are genuinely required
  (currently: nothing — every dependency degrades gracefully by design).
"""

from __future__ import annotations

import time

from fastapi import APIRouter

from ..config import settings
from ..fetch.browser import browser_fetcher
from ..fetch.proxies import proxy_health
from ..llm.client import llm_client
from ..models import HealthResponse

router = APIRouter(tags=["health"])

_STARTED_AT = time.time()


@router.get("/healthz", summary="Liveness probe")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz", response_model=HealthResponse, summary="Readiness and capability report")
async def readyz() -> HealthResponse:
    checks: dict[str, object] = {}

    redis_ok = False
    if settings.redis_url:
        try:
            import redis.asyncio as aioredis

            client = aioredis.from_url(settings.redis_url, decode_responses=True)
            await client.ping()
            await client.aclose()
            redis_ok = True
        except Exception as exc:  # noqa: BLE001
            checks["redis_error"] = type(exc).__name__

    checks["respect_robots"] = settings.respect_robots
    checks["allow_private_networks"] = settings.allow_private_networks
    checks["max_concurrency"] = settings.max_concurrency
    checks["proxy"] = proxy_health()

    warnings = settings.startup_warnings()
    if warnings:
        checks["warnings"] = warnings

    return HealthResponse(
        status="degraded" if warnings else "ok",
        version=__import__("app").__version__,
        browser_available=browser_fetcher.available,
        ai_enabled=llm_client.enabled,
        redis_available=redis_ok,
        uptime_seconds=round(time.time() - _STARTED_AT, 3),
        checks=checks,
    )
