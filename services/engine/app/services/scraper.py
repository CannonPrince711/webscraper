"""The scrape pipeline: fetch → parse → extract → result.

This is the only place in the engine that knows about all three layers, and it
deliberately contains no I/O of its own — no database, no queue, no filesystem.
It converts one URL plus one config into one `PageResult`, which is what makes
it trivially testable and safe to run at any concurrency.

Per-page failure handling is explicit: a page that is blocked by robots, refused
by the SSRF guard, or times out becomes a `PageResult` with a status and a
reason, never an exception that aborts the batch. One bad URL in a 5,000-URL
crawl must not fail the other 4,999.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time

from ..config import settings
from ..core.robots import robots_cache
from ..core.ssrf import SSRFBlocked, validate_url
from ..core.text import truncate
from ..core.urlnorm import content_hash, normalize_url
from ..errors import BrowserUnavailable, EngineError, FetchTimeout, ResponseTooLarge
from ..extract.base import extract_records
from ..fetch.base import fetch_page
from ..llm.client import LLMUsage
from ..models import (
    PageResult,
    ScrapeConfig,
    ScrapeRequest,
    ScrapeResponse,
    ScrapeStats,
)
from ..parse.dom import Dom, parse_html, truncate_html
from ..parse.links import discover_sitemaps, extract_links
from ..parse.metadata import extract_json_ld, extract_metadata, flatten_json_ld

logger = logging.getLogger(__name__)

# Render at most this many pages concurrently; the browser fetcher has its own
# tighter semaphore, so this mostly bounds the HTTP path.
_PAGE_SEMAPHORE: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _PAGE_SEMAPHORE
    if _PAGE_SEMAPHORE is None:
        _PAGE_SEMAPHORE = asyncio.Semaphore(max(1, settings.max_concurrency))
    return _PAGE_SEMAPHORE


async def scrape_one(
    url: str,
    config: ScrapeConfig,
    *,
    depth: int = 0,
    include_html: bool = False,
    usage_sink: list[LLMUsage] | None = None,
) -> PageResult:
    """Fetch, parse and extract a single page. Never raises for page-level issues."""
    started = time.perf_counter()
    spec = config.fetch

    result = PageResult(url=url, final_url=url, status="ok", depth=depth)

    # --- 1. Validate before touching the network ----------------------
    try:
        validated = await validate_url(url)
        result.url = validated.url
        result.final_url = validated.url
    except SSRFBlocked as exc:
        result.status = "blocked_ssrf"
        result.error_code = exc.code
        result.error_message = exc.message
        return result

    # --- 2. robots.txt -------------------------------------------------
    if spec.respect_robots:
        try:
            decision = await robots_cache.get(validated)
        except Exception as exc:  # noqa: BLE001 - a robots failure must not be fatal
            logger.warning("robots check failed for %s: %s", validated.url, type(exc).__name__)
            decision = None

        if decision is not None and not decision.allowed:
            result.status = "blocked_robots"
            result.error_code = "robots_disallowed"
            result.error_message = "Disallowed by robots.txt"
            return result
        if decision is not None and decision.crawl_delay:
            result.warnings.append(f"crawl_delay:{decision.crawl_delay}")

    # --- 3. Fetch ------------------------------------------------------
    try:
        fetched = await fetch_page(validated.url, spec, depth=depth)
    except SSRFBlocked as exc:
        result.status = "blocked_ssrf"
        result.error_code = exc.code
        result.error_message = exc.message
        return result
    except FetchTimeout as exc:
        result.status = "timeout"
        result.error_code = exc.code
        result.error_message = exc.message
        return result
    except ResponseTooLarge as exc:
        result.status = "too_large"
        result.error_code = exc.code
        result.error_message = exc.message
        return result
    except BrowserUnavailable as exc:
        result.status = "error"
        result.error_code = exc.code
        result.error_message = exc.message
        return result
    except EngineError as exc:
        result.status = "error"
        result.error_code = exc.code
        result.error_message = exc.message
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unexpected fetch failure", extra={"url": url, "error_code": type(exc).__name__})
        result.status = "error"
        result.error_code = "unexpected_error"
        result.error_message = "The page could not be fetched"
        return result

    result.final_url = fetched.final_url
    result.http_status = fetched.http_status
    result.content_type = fetched.content_type
    result.body_bytes = fetched.body_bytes
    result.fetch_method = fetched.fetch_method
    result.rendered = fetched.rendered
    result.status = fetched.status
    result.error_code = fetched.error_code
    result.error_message = fetched.error_message

    if fetched.redirect_chain:
        result.warnings.append(f"redirects:{len(fetched.redirect_chain)}")

    # A redirect can land on a different host; robots must be re-checked there
    # or a site could bypass its own rules with a single 302.
    if spec.respect_robots and fetched.final_url != fetched.url:
        try:
            final_decision = await robots_cache.get(await validate_url(fetched.final_url))
            if not final_decision.allowed:
                result.status = "blocked_robots"
                result.error_code = "robots_disallowed_redirect"
                result.error_message = "The redirect target is disallowed by robots.txt"
                return result
        except SSRFBlocked as exc:
            result.status = "blocked_ssrf"
            result.error_code = exc.code
            result.error_message = "The redirect target is not a public address"
            return result
        except Exception:  # noqa: BLE001
            pass

    if not fetched.body:
        result.duration_ms = int((time.perf_counter() - started) * 1000)
        return result

    result.content_hash = content_hash(fetched.body)
    result.duration_ms = int((time.perf_counter() - started) * 1000)

    # --- 4. Parse ------------------------------------------------------
    html = truncate_html(fetched.body, limit=spec.max_bytes)
    dom = parse_html(html)

    metadata = extract_metadata(dom, fetched.final_url)
    json_ld = extract_json_ld(dom)

    result.title = metadata.get("title")
    result.lang = metadata.get("lang")
    result.canonical_url = metadata.get("canonical_url")
    result.metadata = metadata
    result.json_ld = flatten_json_ld(json_ld)[:50]
    result.headings = dom.all_headings(limit=60)
    result.links = extract_links(dom, fetched.final_url)
    result.sitemaps = discover_sitemaps(dom, fetched.final_url)

    result.text = truncate(dom.text_content(), 200_000, suffix="")
    try:
        result.markdown = dom.markdown(limit_chars=200_000)
    except Exception as exc:  # noqa: BLE001 - markdown is a nice-to-have
        logger.debug("Markdown extraction failed: %s", type(exc).__name__)
        result.markdown = None

    if include_html and spec.save_html:
        result.html = html

    if fetched.screenshot_png:
        result.screenshot_png_b64 = base64.b64encode(fetched.screenshot_png).decode("ascii")

    # --- 5. Extract ----------------------------------------------------
    extraction = await extract_records(
        dom,
        config,
        base_url=fetched.final_url,
        json_ld=json_ld,
        allow_llm=config.ai.enrich or config.extract.strategy.value == "llm",
    )

    result.records = extraction.records
    result.record_confidences = extraction.confidences
    result.warnings.extend(extraction.warnings)
    result.extraction = {
        "strategy": extraction.strategy,
        **extraction.diagnostics,
    }
    if extraction.suggested_config:
        result.extraction["suggestedConfig"] = extraction.suggested_config

    result.duration_ms = int((time.perf_counter() - started) * 1000)
    return result


async def scrape(request: ScrapeRequest) -> ScrapeResponse:
    """Run a batch of URLs under one config, bounded and deadline-aware."""
    started = time.perf_counter()
    config = request.config
    urls = (request.urls or config.targets)[: settings.max_pages_per_request]

    semaphore = _semaphore()
    usage_sink: list[LLMUsage] = []
    deadline = (request.deadline_ms / 1000) if request.deadline_ms else None

    async def run(target: str) -> PageResult:
        async with semaphore:
            try:
                if deadline:
                    async with asyncio.timeout(deadline):
                        return await scrape_one(
                            target,
                            config,
                            depth=request.depth,
                            include_html=request.include_html,
                            usage_sink=usage_sink,
                        )
                return await scrape_one(
                    target,
                    config,
                    depth=request.depth,
                    include_html=request.include_html,
                    usage_sink=usage_sink,
                )
            except TimeoutError:
                return PageResult(
                    url=target, final_url=target, status="timeout", depth=request.depth,
                    error_code="deadline_exceeded",
                    error_message="The batch deadline was reached before this page finished",
                )

    results = await asyncio.gather(*(run(url) for url in urls), return_exceptions=False)

    # --- discovery for the worker's crawl frontier --------------------
    discovered: list[str] = []
    if config.mode in {"crawl", "sitemap"}:
        from ..core.ssrf import is_url_in_scope
        from ..core.urlnorm import has_document_extension

        allowed_hosts: set[str] = set()
        registrable: str | None = None
        for target in config.targets:
            try:
                validated = await validate_url(target)
                allowed_hosts.add(validated.host)
                registrable = registrable or (validated.registrable_hint if config.crawl.same_domain else None)
            except SSRFBlocked:
                continue

        seen: set[str] = set()
        for page in results:
            for link in page.links:
                if link.get("nofollow") and not config.crawl.follow_nofollow:
                    continue
                if link.get("is_pagination") and len(discovered) < config.crawl.max_pages:
                    discovered.append(link["normalized_url"])
                    continue
                candidate = link["url"]
                if has_document_extension(candidate):
                    continue
                if not is_url_in_scope(candidate, allowed_hosts=allowed_hosts,
                                       same_domain=config.crawl.same_domain, registrable=registrable):
                    continue
                normalized = normalize_url(candidate)
                if normalized in seen:
                    continue
                seen.add(normalized)
                discovered.append(candidate)

    warnings: list[str] = []
    if usage_sink:
        total_cost = sum(u.cost_usd for u in usage_sink)
        total_tokens = sum(u.total_tokens for u in usage_sink)
        warnings.append(f"ai_usage:tokens={total_tokens},cost_usd={round(total_cost, 6)}")

    stats = ScrapeStats(
        pages_total=len(results),
        pages_ok=sum(1 for r in results if r.status in {"ok", "not_modified"}),
        pages_failed=sum(1 for r in results if r.status not in {"ok", "not_modified"}),
        bytes_total=sum(r.body_bytes for r in results),
        records_total=sum(len(r.records) for r in results),
        duration_ms=int((time.perf_counter() - started) * 1000),
        browser_renders=sum(1 for r in results if r.rendered),
    )

    return ScrapeResponse(results=results, stats=stats, discovered=discovered, warnings=warnings)


def build_dom_for_html(html: str) -> Dom:
    return parse_html(html)
