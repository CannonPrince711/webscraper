"""Scrape, extract, sitemap, robots and selector-probe endpoints."""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..core.robots import check_robots
from ..core.sitemap import parse_sitemap
from ..core.ssrf import SSRFBlocked, validate_url
from ..core.text import clean_text, truncate
from ..deps import AuthDep
from ..errors import EngineError
from ..fetch.http import http_fetcher
from ..models import (
    ExtractRequest,
    FetchSpec,
    RenderMode,
    ScrapeRequest,
    ScrapeResponse,
    SelectorProbe,
)
from ..parse.dom import parse_html
from ..services.scraper import scrape, scrape_one

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["scrape"])


@router.post("/scrape", response_model=ScrapeResponse, summary="Fetch, parse and extract a batch")
async def post_scrape(_: AuthDep, request: ScrapeRequest) -> ScrapeResponse:
    return await scrape(request)


class UrlListRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=50)
    fetch: FetchSpec = Field(default_factory=FetchSpec)
    include_html: bool = False


@router.post("/fetch", summary="Raw fetch only — no extraction")
async def post_fetch(_: AuthDep, request: UrlListRequest) -> dict[str, Any]:
    """Used by the worker for artifact capture and by monitors for cheap checks."""
    results = []
    for url in request.urls[:50]:
        try:
            fetched = await http_fetcher.fetch(url, request.fetch)
            results.append(
                {
                    "url": url,
                    "finalUrl": fetched.final_url,
                    "status": fetched.status,
                    "httpStatus": fetched.http_status,
                    "contentType": fetched.content_type,
                    "bodyBytes": fetched.body_bytes,
                    "durationMs": fetched.duration_ms,
                    "redirects": fetched.redirect_chain,
                    "html": fetched.body if request.include_html else None,
                    "error": fetched.error_message,
                }
            )
        except EngineError as exc:
            results.append({"url": url, "status": "error", "errorCode": exc.code, "error": exc.message})

    return {"results": results, "count": len(results)}


@router.post("/extract", summary="Extract from supplied HTML (or a URL) without a full scrape")
async def post_extract(_: AuthDep, request: ExtractRequest) -> dict[str, Any]:
    """The workhorse behind the visual picker: no network round trip needed."""
    started = time.perf_counter()

    html = request.html
    base_url = request.url or "https://example.invalid/"

    if not html:
        assert request.url is not None
        page = await scrape_one(request.url, request.config)
        if page.status != "ok":
            return {
                "status": page.status,
                "errorCode": page.error_code,
                "error": page.error_message,
                "records": [],
            }
        return {
            "status": "ok",
            "url": page.final_url,
            "records": page.records,
            "confidences": page.record_confidences,
            "extraction": page.extraction,
            "warnings": page.warnings,
            "durationMs": page.duration_ms,
        }

    from ..extract.base import extract_records
    from ..parse.metadata import extract_json_ld

    dom = parse_html(html)
    json_ld = extract_json_ld(dom)
    result = await extract_records(dom, request.config, base_url=base_url, json_ld=json_ld)

    return {
        "status": "ok",
        "url": base_url,
        "records": result.records,
        "confidences": result.confidences,
        "extraction": {"strategy": result.strategy, **result.diagnostics},
        "suggestedConfig": result.suggested_config,
        "warnings": result.warnings,
        "durationMs": int((time.perf_counter() - started) * 1000),
    }


class SelectorPreviewRequest(BaseModel):
    html: str | None = Field(None, max_length=10_000_000)
    url: str | None = None
    # Either a list of bare selectors, or field-shaped objects.
    selectors: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    sample_limit: int = Field(5, ge=1, le=20)


@router.post("/selectors/preview", response_model=list[SelectorProbe], summary="Test selectors against a page")
async def post_selectors_preview(_: AuthDep, request: SelectorPreviewRequest) -> list[SelectorProbe]:
    html = request.html
    if not html:
        if not request.url:
            raise HTTPException(status_code=422, detail="Provide html or url")
        try:
            fetched = await http_fetcher.fetch(request.url, FetchSpec())
        except EngineError as exc:
            raise HTTPException(status_code=502, detail=exc.message) from exc
        html = fetched.body

    dom = parse_html(html)
    probes: list[SelectorProbe] = []

    for index, item in enumerate(request.selectors[:100]):
        name = str(item.get("name") or f"field_{index}")
        selector = str(item.get("selector") or "").strip()
        selector_type = str(item.get("selector_type") or item.get("selectorType") or "css")
        attribute = item.get("attribute")

        probe = SelectorProbe(name=name, selector=selector, selector_type=selector_type if selector_type in {"css", "xpath"} else "css", attribute=attribute)
        if not selector:
            probe.error = "empty selector"
            probes.append(probe)
            continue

        try:
            # strict=True: the picker shows the difference between "matched
            # nothing" and "that selector is not valid" to the user.
            nodes = (
                dom.xpath(selector, limit=request.sample_limit, strict=True)
                if probe.selector_type == "xpath"
                else dom.css(selector, limit=request.sample_limit, strict=True)
            )
            probe.matches = len(nodes)
            for node in nodes:
                if attribute:
                    value = node.attr(str(attribute))
                else:
                    value = node.text()
                if value:
                    probe.samples.append(truncate(clean_text(str(value)), 200))
        except Exception as exc:  # noqa: BLE001 - invalid selectors are user input
            probe.error = f"invalid selector ({type(exc).__name__})"

        probes.append(probe)

    return probes


class RobotsCheckRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=50)


@router.post("/robots/check", summary="Check robots.txt for one or more URLs")
async def post_robots_check(_: AuthDep, request: RobotsCheckRequest) -> dict[str, Any]:
    out = []
    for url in request.urls[:50]:
        try:
            decision = await check_robots(url)
            out.append(
                {
                    "url": url,
                    "allowed": decision.allowed,
                    "reason": decision.reason,
                    "crawlDelay": decision.crawl_delay,
                    "sitemaps": list(decision.sitemaps),
                }
            )
        except SSRFBlocked as exc:
            out.append({"url": url, "allowed": False, "reason": exc.details.get("reason", "blocked")})
        except Exception as exc:  # noqa: BLE001
            out.append({"url": url, "allowed": False, "reason": type(exc).__name__})
    return {"results": out}


class SsrfCheckRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=100)
    resolve_dns: bool = True


@router.post("/ssrf/check", summary="Validate URLs against the egress policy")
async def post_ssrf_check(_: AuthDep, request: SsrfCheckRequest) -> dict[str, Any]:
    """Pre-flight check used by the UI (instant feedback) and the worker (filter)."""
    out = []
    for url in request.urls[:100]:
        try:
            target = await validate_url(url, resolve=request.resolve_dns)
            out.append(
                {
                    "url": url,
                    "allowed": True,
                    "normalizedUrl": target.url,
                    "host": target.host,
                    "resolvedIps": target.resolved_ips,
                }
            )
        except SSRFBlocked as exc:
            out.append({"url": url, "allowed": False, "reason": exc.message, "code": exc.details.get("reason")})
        except Exception as exc:  # noqa: BLE001
            out.append({"url": url, "allowed": False, "reason": type(exc).__name__})
    return {"results": out}


class SitemapRequest(BaseModel):
    url: str
    follow_nested: bool = True
    max_sitemaps: int = Field(10, ge=1, le=50)
    max_urls: int = Field(5000, ge=1, le=50_000)


@router.post("/sitemap", summary="Fetch and parse a sitemap (including nested index files)")
async def post_sitemap(_: AuthDep, request: SitemapRequest) -> dict[str, Any]:
    spec = FetchSpec(render=RenderMode.HTTP, save_html=True, max_bytes=20_000_000)

    queue = [request.url]
    visited: set[str] = set()
    entries: list[dict[str, Any]] = []
    sitemaps_read = 0
    truncated = False

    while queue and sitemaps_read < request.max_sitemaps and len(entries) < request.max_urls:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        sitemaps_read += 1

        try:
            fetched = await http_fetcher.fetch(current, spec)
        except EngineError as exc:
            logger.info("Sitemap fetch failed", extra={"url": current, "error_code": exc.code})
            continue

        if fetched.status != "ok":
            continue

        # The fetcher already decoded the body; gzip is handled there.
        parsed = parse_sitemap(fetched.body)
        truncated = truncated or parsed.truncated

        for entry in parsed.entries:
            if len(entries) >= request.max_urls:
                truncated = True
                break
            entries.append(
                {
                    "url": entry.url,
                    "lastmod": entry.lastmod.isoformat() if entry.lastmod else None,
                    "changefreq": entry.changefreq,
                    "priority": entry.priority,
                }
            )

        if request.follow_nested:
            for nested in parsed.nested_sitemaps:
                if nested not in visited and len(queue) < request.max_sitemaps:
                    queue.append(nested)

    return {
        "entries": entries,
        "count": len(entries),
        "sitemapsRead": sitemaps_read,
        "truncated": truncated,
    }
