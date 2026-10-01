"""Per-domain politeness.

Two independent limits:

* **Rate** — a token bucket per registrable domain, default 2 rps with a burst
  of 5. Keeps us from looking like an attack even when a job asks for
  concurrency 32.
* **Concurrency** — a semaphore per domain, so a slow host is not stacked with
  parallel sockets.

When ``REDIS_URL`` is configured the token bucket is shared across engine
replicas (a fixed-window counter, which is approximate but cannot be defeated
by adding pods). Without Redis it degrades to a per-process bucket, which is
correct for a single-replica deployment.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field

from ..config import settings

logger = logging.getLogger(__name__)


@dataclass
class _Bucket:
    capacity: float
    refill_per_second: float
    tokens: float
    updated_at: float = field(default_factory=time.monotonic)

    def take(self, amount: float = 1.0) -> float:
        """Consume a token. Returns the seconds the caller must wait (0 = go)."""
        now = time.monotonic()
        elapsed = now - self.updated_at
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_second)
        self.updated_at = now

        if self.tokens >= amount:
            self.tokens -= amount
            return 0.0

        deficit = amount - self.tokens
        return deficit / self.refill_per_second


class InProcessRateLimiter:
    def __init__(self, rps: float | None = None, burst: int | None = None) -> None:
        self.rps = rps if rps is not None else settings.rate_limit_per_domain_rps
        self.burst = burst if burst is not None else settings.rate_limit_burst
        self._buckets: dict[str, _Bucket] = {}
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def acquire(self, key: str, amount: float = 1.0) -> None:
        while True:
            async with self._locks[key]:
                bucket = self._buckets.get(key)
                if bucket is None:
                    bucket = _Bucket(capacity=float(self.burst), refill_per_second=self.rps, tokens=float(self.burst))
                    self._buckets[key] = bucket
                wait = bucket.take(amount)
            if wait <= 0:
                return
            # Cap the sleep so a misconfigured refill rate cannot stall a worker
            # for minutes; the loop re-checks under the lock afterwards.
            await asyncio.sleep(min(wait, 5.0))

    def snapshot(self) -> dict[str, float]:
        return {k: round(v.tokens, 3) for k, v in self._buckets.items()}


class RedisRateLimiter:
    """Fixed-window counter shared across replicas.

    A sliding window would be more precise; a fixed window is far cheaper and
    the worst case (2x burst at a window boundary) is tolerable for politeness
    purposes. The Lua script keeps INCR+EXPIRE atomic.
    """

    _SCRIPT = """
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return current
    """

    def __init__(self, client, rps: float | None = None) -> None:
        self.client = client
        self.rps = rps if rps is not None else settings.rate_limit_per_domain_rps
        self._script = None

    async def acquire(self, key: str, amount: float = 1.0) -> None:
        window_ms = 1000
        limit = max(1, int(self.rps))
        redis_key = f"rl:{key}:{int(time.time() * 1000) // window_ms}"

        if self._script is None:
            self._script = self.client.register_script(self._SCRIPT)
        current = await self._script(keys=[redis_key], args=[window_ms * 2])

        if int(current) > limit:
            # Sleep to the next window boundary, then retry exactly once.
            wait = (window_ms - (time.time() * 1000) % window_ms) / 1000
            await asyncio.sleep(min(wait + 0.01, 1.5))
            redis_key = f"rl:{key}:{int(time.time() * 1000) // window_ms}"
            await self._script(keys=[redis_key], args=[window_ms * 2])

    def snapshot(self) -> dict[str, float]:
        return {}


class DomainGate:
    """Combines the rate limiter with a per-domain concurrency semaphore."""

    def __init__(self, limiter, max_per_domain: int = 4) -> None:
        self.limiter = limiter
        self.max_per_domain = max_per_domain
        self._semaphores: defaultdict[str, asyncio.Semaphore] = defaultdict(
            lambda: asyncio.Semaphore(self.max_per_domain)
        )

    async def __aenter__(self) -> DomainGate:
        return self

    async def __aexit__(self, *exc_info) -> None:
        return None

    def hold(self, domain: str, *, crawl_delay: float | None = None) -> _GateContext:
        """Return an async context manager that waits for a slot, then a token.

        Deliberately *not* an `async def`: it must yield the context manager
        itself so callers can write `async with gate.hold(domain):`.
        """
        return _GateContext(self, domain, crawl_delay)


class _GateContext:
    def __init__(self, gate: DomainGate, domain: str, crawl_delay: float | None) -> None:
        self.gate = gate
        self.domain = domain
        self.crawl_delay = crawl_delay
        self._sem: asyncio.Semaphore | None = None

    async def __aenter__(self):
        self._sem = self.gate._semaphores[self.domain]
        await self._sem.acquire()
        await self.gate.limiter.acquire(self.domain)
        if self.crawl_delay:
            # robots.txt crawl-delay is a floor, not a target: it can only slow
            # us down, never speed us up past the configured rps.
            delay = min(float(self.crawl_delay), 30.0)
            implied_rps = 1.0 / delay
            if implied_rps < self.gate.limiter.rps:
                await asyncio.sleep(delay - (1.0 / self.gate.limiter.rps))
        return self

    async def __aexit__(self, *exc_info) -> None:
        if self._sem is not None:
            self._sem.release()


def build_limiter():
    """Pick a limiter implementation based on configuration."""
    if settings.redis_url:
        try:
            import redis.asyncio as aioredis

            client = aioredis.from_url(settings.redis_url, decode_responses=True)
            return RedisRateLimiter(client)
        except Exception as exc:  # pragma: no cover - depends on environment
            logger.warning("Redis rate limiter unavailable, falling back to in-process: %s", exc)
    return InProcessRateLimiter()


# Process-wide gate shared by all fetch paths.
domain_gate = DomainGate(build_limiter())
