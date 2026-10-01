"""robots.txt fetching, caching and evaluation.

Design decisions:

* **Honoured by default.** ``respect_robots`` defaults to true and a job must
  explicitly opt out, which the worker records in the audit log with a reason.
* **Fail-closed or fail-open?** On 5xx / network errors we default to
  *disallow* (``robots_fail_open=False``). A site whose robots.txt is broken is
  more likely to be struggling than to be inviting a crawl.
* **4xx means allow.** A missing robots.txt is an explicit "no rules" signal
  per RFC 9309.
* **Cached.** TTL-cached per origin (in-memory, optionally Redis-shared), so a
  500-page crawl fetches robots.txt once, not 500 times.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlsplit
from urllib.robotparser import RobotFileParser

import httpx

from ..config import settings
from ..errors import SSRFBlocked
from .ssrf import ValidatedTarget, validate_url

logger = logging.getLogger(__name__)

_MAX_ROBOTS_BYTES = 512_000


def _normalized_path(url: str) -> str:
    """Reduce a URL to the quoted path+query form `Entry.allowance` expects.

    Mirrors what `RobotFileParser.can_fetch` does internally. Calling
    `allowance()` with a full URL silently matches nothing (every rule is
    compared with `startswith` against a path), which would allow everything —
    a failure mode worth being explicit about.
    """
    parsed = urlsplit(unquote(url))
    # urlsplit keeps ";params" inside .path, matching what the stdlib passes on.
    value = parsed.path or "/"
    if parsed.query:
        value = f"{value}?{parsed.query}"
    if parsed.fragment:
        value = f"{value}#{parsed.fragment}"
    return quote(value)


def _combined_allowance(parser: RobotFileParser, user_agent: str, url: str) -> bool:
    """Union of every group that applies to us; the most restrictive wins.

    Two problems with using `RobotFileParser.can_fetch` directly:

    1. It stops at the *first* entry whose user-agent matches, so a
       `WebscraperBot` group silently discards every rule in the `*` group,
       even when the specific group is the narrower of the two.
    2. `parser.entries` does not include the `*` group — that lives in
       `default_entry` — so any code iterating `entries` misses the rules that
       apply to almost every site.

    RFC 9309 leaves the combination question ambiguous; Google's documented
    behaviour is that all matching groups apply. The asymmetry of getting this
    wrong decides the direction: over-blocking is visible and overridable per
    job with an audit note, whereas under-blocking is a compliance incident.
    """
    if parser.disallow_all:
        return False
    if parser.allow_all:
        return True

    path = _normalized_path(url)
    verdicts: list[bool] = []

    for entry in _all_entries(parser):
        try:
            if entry.applies_to(user_agent):
                verdicts.append(bool(entry.allowance(path)))
        except Exception:  # pragma: no cover - defensive against odd rule sets
            verdicts.append(False)

    if not verdicts:
        return True   # agent not mentioned anywhere => access granted
    return all(verdicts)


def _all_entries(parser: RobotFileParser) -> list:
    """Every group in the file, including the `*` default group."""
    entries = list(parser.entries)
    if parser.default_entry is not None:
        entries.append(parser.default_entry)
    return entries


@dataclass(slots=True)
class RobotsDecision:
    allowed: bool
    crawl_delay: float | None = None
    reason: str = "allowed"
    sitemaps: tuple[str, ...] = ()


@dataclass
class _CacheEntry:
    parser: RobotFileParser | None
    sitemaps: tuple[str, ...]
    allow_all: bool
    fetched_at: float
    crawl_delay: float | None = None


class RobotsCache:
    def __init__(self) -> None:
        self._entries: dict[str, _CacheEntry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    async def _lock_for(self, origin: str) -> asyncio.Lock:
        async with self._global_lock:
            return self._locks.setdefault(origin, asyncio.Lock())

    def _fresh(self, entry: _CacheEntry) -> bool:
        return (time.time() - entry.fetched_at) < settings.robots_cache_ttl_seconds

    async def get(self, target: ValidatedTarget, *, user_agent: str | None = None) -> RobotsDecision:
        ua = user_agent or settings.user_agent
        origin = target.origin

        entry = self._entries.get(origin)
        if entry is not None and self._fresh(entry):
            return self._decide(entry, target, ua)

        async with await self._lock_for(origin):
            # Re-check: another coroutine may have refreshed while we waited.
            entry = self._entries.get(origin)
            if entry is not None and self._fresh(entry):
                return self._decide(entry, target, ua)

            entry = await self._fetch(target)
            self._entries[origin] = entry
            return self._decide(entry, target, ua)

    async def _fetch(self, target: ValidatedTarget) -> _CacheEntry:
        robots_url = f"{target.origin}/robots.txt"
        try:
            # The robots fetch is itself SSRF-checked: robots.txt can live on a
            # host that redirects somewhere private.
            validated = await validate_url(robots_url)
        except SSRFBlocked as exc:
            logger.warning("robots.txt URL rejected: %s", exc.message)
            return _CacheEntry(None, (), allow_all=False, fetched_at=time.time())

        headers = {"User-Agent": settings.user_agent, "Accept": "text/plain,*/*;q=0.8"}
        timeout = httpx.Timeout(
            connect=settings.connect_timeout_ms / 1000,
            read=min(10.0, settings.request_timeout_ms / 1000),
            write=5.0,
            pool=5.0,
        )
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=False,
                headers=headers,
                proxy=settings.proxy_urls[0] if settings.proxy_urls else None,
            ) as client:
                response = await client.get(validated.url)
        except (httpx.HTTPError, OSError) as exc:
            logger.warning("robots.txt fetch failed for %s: %s", target.origin, type(exc).__name__)
            # Network failure: honour the fail-open/fail-closed setting.
            return _CacheEntry(None, (), allow_all=settings.robots_fail_open, fetched_at=time.time())

        if response.status_code == 404 or 400 <= response.status_code < 500:
            # No rules published => allowed, per RFC 9309 §2.3.1.
            return _CacheEntry(None, (), allow_all=True, fetched_at=time.time())

        if response.status_code >= 500:
            return _CacheEntry(None, (), allow_all=settings.robots_fail_open, fetched_at=time.time())

        body = response.content[:_MAX_ROBOTS_BYTES].decode("utf-8", errors="replace")
        parser = RobotFileParser()
        parser.set_url(validated.url)
        parser.parse(body.splitlines())

        sitemaps: list[str] = []
        crawl_delay: float | None = None
        for line in body.splitlines():
            stripped = line.split("#", 1)[0].strip()
            if not stripped or ":" not in stripped:
                continue
            field, _, value = stripped.partition(":")
            field = field.strip().lower()
            value = value.strip()
            if field == "sitemap" and value:
                sitemaps.append(value)
            elif field in {"crawl-delay", "request-rate"} and value and crawl_delay is None:
                try:
                    crawl_delay = float(value.split("/")[0]) if "request-rate" in field else float(value)
                except ValueError:
                    continue

        return _CacheEntry(parser, tuple(sitemaps), allow_all=False, fetched_at=time.time(), crawl_delay=crawl_delay)

    def _decide(self, entry: _CacheEntry, target: ValidatedTarget, user_agent: str) -> RobotsDecision:
        if not settings.respect_robots:
            return RobotsDecision(True, None, "robots_disabled", entry.sitemaps)

        if entry.allow_all or entry.parser is None:
            return RobotsDecision(entry.allow_all, None, "no_rules" if entry.allow_all else "robots_unavailable", entry.sitemaps)

        # "WebscraperBot" is what our UA advertises.
        ua_token = user_agent.split("/")[0].split(" ")[0] or "*"
        allowed = _combined_allowance(entry.parser, user_agent, target.url)

        delay = entry.crawl_delay
        try:
            parsed_delay = entry.parser.crawl_delay(user_agent) or entry.parser.crawl_delay(ua_token)
            if parsed_delay:
                delay = max(delay or 0, float(parsed_delay))
        except Exception:  # pragma: no cover - robotparser is lenient
            pass

        return RobotsDecision(allowed, delay, "allowed" if allowed else "disallowed", entry.sitemaps)

    async def sitemaps_for(self, target: ValidatedTarget) -> tuple[str, ...]:
        decision = await self.get(target)
        return decision.sitemaps

    def clear(self) -> None:
        self._entries.clear()


# Process-wide cache: one robots.txt per origin per hour, shared by all requests.
robots_cache = RobotsCache()


async def check_robots(url: str, *, user_agent: str | None = None) -> RobotsDecision:
    target = await validate_url(url)
    return await robots_cache.get(target, user_agent=user_agent)
