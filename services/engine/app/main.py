"""FastAPI application entry point.

Run locally:
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

Interactive API docs: http://localhost:8000/docs
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import configure_logging, settings
from .errors import EngineError, Unauthorized
from .fetch.base import close_fetchers
from .fetch.browser import browser_fetcher
from .llm.client import llm_client
from .routers import ai, health, proxy, scrape

configure_logging(settings.log_level, json_output=settings.log_json)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    for warning in settings.startup_warnings():
        logger.warning("Configuration warning: %s", warning)

    logger.info(
        "Engine starting",
        extra={
            "status_code": None,
        },
    )
    logger.info(
        "Engine ready (concurrency=%s, browser=%s, ai=%s, robots=%s)",
        settings.max_concurrency,
        settings.enable_browser,
        llm_client.enabled,
        settings.respect_robots,
    )

    try:
        yield
    finally:
        logger.info("Engine shutting down")
        await close_fetchers()
        await llm_client.aclose()
        await browser_fetcher.aclose()


app = FastAPI(
    title="Webscraper Engine",
    description=(
        "High-performance scraping engine: hardened fetching (SSRF guard, robots.txt, "
        "per-domain politeness), structured extraction (selectors, structural heuristics, "
        "schema-guided LLM) and a browser renderer for JavaScript-heavy pages."
    ),
    version=__version__,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
)

# CORS is opt-in: the Next.js BFF calls this service server-to-server, so the
# default posture is "no browser origin may call it directly".
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "X-Webscraper-Signature"],
        max_age=600,
    )


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------
@app.middleware("http")
async def request_context(request: Request, call_next):
    """Attach a request id, time the call, and add baseline security headers."""
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    started = time.perf_counter()

    response = await call_next(request)

    duration_ms = int((time.perf_counter() - started) * 1000)
    response.headers["x-request-id"] = request_id
    response.headers["x-response-time-ms"] = str(duration_ms)
    response.headers["x-content-type-options"] = "nosniff"
    response.headers["referrer-policy"] = "no-referrer"

    # Never log the query string: it can contain a scrape target, which is
    # customer data.
    if request.url.path not in {"/healthz"}:
        logger.info(
            "%s %s -> %s",
            request.method,
            request.url.path,
            response.status_code,
            extra={"request_id": request_id, "duration_ms": duration_ms, "status_code": response.status_code},
        )
    return response


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------
@app.exception_handler(EngineError)
async def engine_error_handler(_: Request, exc: EngineError) -> JSONResponse:
    """Typed errors become a stable envelope the worker can switch on."""
    headers = {}
    if isinstance(exc, Unauthorized):
        headers["WWW-Authenticate"] = "Bearer"
    if exc.retryable:
        headers["Retry-After"] = "5"
    return JSONResponse(status_code=exc.http_status, content=exc.to_dict(), headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    """Surface *why* a config was rejected, in a shape the UI can render.

    Field paths are included but values are not echoed, so a payload containing
    a secret or personal data cannot bounce back into the response or a log.
    """
    problems = []
    for error in exc.errors()[:10]:
        location = ".".join(str(part) for part in error.get("loc", ()) if part != "body")
        problems.append({"field": location or "(root)", "message": str(error.get("msg", "invalid"))})
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": "invalid_config",
                "message": "The request did not validate",
                "retryable": False,
                "details": {"problems": problems},
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """Last resort: log the detail, return none of it."""
    logger.exception("Unhandled engine error: %s", type(exc).__name__)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal_error",
                "message": "The engine hit an unexpected error. It has been logged.",
                "retryable": True,
                "details": {},
            }
        },
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
app.include_router(health.router)
app.include_router(scrape.router)
app.include_router(ai.router)
app.include_router(proxy.router)


@app.get("/", include_in_schema=False)
async def index() -> dict[str, Any]:
    return {
        "service": settings.app_name,
        "version": __version__,
        "docs": "/docs",
        "endpoints": [
            "POST /v1/scrape",
            "POST /v1/fetch",
            "POST /v1/extract",
            "POST /v1/selectors/preview",
            "POST /v1/robots/check",
            "POST /v1/ssrf/check",
            "POST /v1/sitemap",
            "GET  /v1/ai/status",
            "POST /v1/ai/infer-schema",
            "POST /v1/ai/config",
            "POST /v1/ai/enrich",
            "GET  /healthz",
            "GET  /readyz",
        ],
    }
