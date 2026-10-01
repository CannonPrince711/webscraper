"""HTTP fetcher.

Hardened against the failure modes that a "just use requests.get()" wrapper
ignores:

* **Unbounded responses / zip bombs.** The body is streamed and capped twice:
  a raw-byte ceiling and a decompression-ratio check. A 1 KB gzip that expands
  to 10 GB is stopped after a few megabytes, not after the OOM killer fires.
* **Redirect escapes.** Redirects are never auto-followed. Every `Location` is
  re-validated through the SSRF guard before the next hop.
* **DNS rebinding.** The connection is pinned to the IP that was validated
  (see `build_pinned_request`); the `Host` header and TLS SNI keep the original
  name so certificates still verify.
* **Slowloris / infinite streams.** A read timeout plus a global wall-clock
  deadline, enforced while streaming, not just at connect.
* **Connection churn.** One pooled `AsyncClient` per proxy, reused across
  requests.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
import zlib
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from ..config import settings
from ..core.ratelimit import domain_gate
from ..core.ssrf import ValidatedTarget, validate_url
from ..errors import (
    FetchFailed,
    FetchTimeout,
    ResponseTooLarge,
    SSRFBlocked,
    UnsupportedContentType,
)
from ..models import FetchResult, FetchSpec
from .proxies import resolve_proxy

logger = logging.getLogger(__name__)

# Content types we are willing to hand to the parsers. Anything else is either
# binary (nothing to extract) or a security risk (SVG with script, PDF with JS).
TEXTUAL_CONTENT_TYPES: tuple[str, ...] = (
    "text/html", "application/xhtml+xml", "application/xml", "text/xml",
    "text/plain", "application/json", "application/ld+json",
    "application/rss+xml", "application/atom+xml", "application/x-ndjson",
)

# Sent on every request; callers may add to these but never remove them.
BASE_HEADERS: dict[str, str] = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
    # Brotli is deliberately not advertised: we decompress in-process under our
    # own size caps, and gzip/deflate are sufficient for real-world sites.
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
}

_RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 522, 524})
_MAX_ATTEMPTS = 3


def decode_body(raw: bytes, content_type: str | None) -> str:
    """Decode bytes to text using the charset the server declared."""
    charset = None
    if content_type:
        for part in content_type.split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.strip().lower() == "charset":
                charset = value.strip().strip('"').lower()
                break

    candidates = [charset] if charset else []
    candidates += ["utf-8", "windows-1252", "latin-1"]

    for encoding in candidates:
        if not encoding:
            continue
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def _decompress(raw: bytes, encoding: str, limit: int) -> bytes:
    """Decompress with an explicit output ceiling.

    `zlib.decompress` with a bounded `decompressobj` lets us stop mid-stream
    when the output exceeds the limit — the defence against a compression bomb.
    """
    encoding = (encoding or "").lower().strip()
    if encoding in ("", "identity"):
        return raw

    wbits = {"gzip": 16 + zlib.MAX_WBITS, "x-gzip": 16 + zlib.MAX_WBITS,
             "deflate": zlib.MAX_WBITS, "zlib": zlib.MAX_WBITS}.get(encoding)
    if wbits is None:
        raise UnsupportedContentType(
            f"Unsupported Content-Encoding '{encoding}'",
            details={"encoding": encoding},
        )

    decompressor = zlib.decompressobj(wbits)
    try:
        # A single call with max_length bounds the work; leftover bytes are
        # reported rather than silently expanding in memory.
        out = decompressor.decompress(raw, limit)
    except zlib.error as exc:
        raise FetchFailed(f"Malformed {encoding} body", details={"encoding": encoding}) from exc

    if decompressor.unconsumed_tail:
        raise ResponseTooLarge(
            "Compressed response expands beyond the configured limit",
            details={"limit_bytes": limit, "encoding": encoding},
        )
    return out


def build_pinned_request(
    client: httpx.AsyncClient,
    method: str,
    target: ValidatedTarget,
    headers: dict[str, str],
) -> httpx.Request:
    """Build a request addressed to the validated IP, preserving the hostname.

    Sending the request to the IP closes the window between "we resolved this
    and checked it" and "the socket opened". `Host` and TLS SNI stay the
    original name so virtual hosting and certificate validation still work.
    """
    if not target.pinned_ip:
        return client.build_request(method, target.url, headers=headers)

    parts = urlsplit(target.url)
    host_literal = f"[{target.pinned_ip}]" if ":" in target.pinned_ip else target.pinned_ip
    default_port = 443 if parts.scheme == "https" else 80
    netloc = host_literal if target.port == default_port else f"{host_literal}:{target.port}"
    pinned_url = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))

    request = client.build_request(method, pinned_url, headers={**headers, "Host": target.host_header})
    # httpcore reads this for both SNI and certificate hostname verification.
    request.extensions["sni_hostname"] = target.host
    return request


class HttpFetcher:
    """Pooled, retrying, size-capped HTTP client. One instance per process."""

    def __init__(self) -> None:
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._lock = asyncio.Lock()

    async def _client_for(self, proxy: str | None) -> httpx.AsyncClient:
        key = proxy or ""
        async with self._lock:
            client = self._clients.get(key)
            if client is not None and not client.is_closed:
                return client
            limits = httpx.Limits(
                max_connections=max(10, settings.max_concurrency * 4),
                max_keepalive_connections=max(5, settings.max_concurrency * 2),
                keepalive_expiry=30.0,
            )
            timeout = httpx.Timeout(
                connect=settings.connect_timeout_ms / 1000,
                read=settings.request_timeout_ms / 1000,
                write=10.0,
                pool=10.0,
            )
            client = httpx.AsyncClient(
                limits=limits,
                timeout=timeout,
                follow_redirects=False,          # we re-validate each hop ourselves
                headers={"User-Agent": settings.user_agent, **BASE_HEADERS},
                http2=True,
                proxy=proxy,
                trust_env=False,                 # ignore ambient HTTP_PROXY vars
            )
            self._clients[key] = client
            return client

    async def aclose(self) -> None:
        for client in self._clients.values():
            await client.aclose()
        self._clients.clear()

    # ------------------------------------------------------------------
    async def fetch(self, url: str, spec: FetchSpec, *, depth: int = 0) -> FetchResult:
        started = time.perf_counter()
        deadline = started + spec.timeout_ms / 1000

        # `spec.proxy` is a policy ('decodo', an explicit URL, or empty), not
        # necessarily a ready URL: managed providers keep their credentials in
        # the server environment. `decision.url` contains a password, so it is
        # never logged — only `decision.label` is.
        decision = resolve_proxy(spec.proxy)
        proxy = decision.url
        if decision.warnings:
            logger.warning(
                "Proxy policy warning: %s",
                decision.warnings[0],
                extra={"domain": urlsplit(url).hostname or ""},
            )
        target = await validate_url(url, allow_private=None)

        headers: dict[str, str] = {}
        if spec.user_agent:
            headers["User-Agent"] = spec.user_agent
        if spec.referer:
            headers["Referer"] = spec.referer
        headers.update(spec.headers)

        redirect_chain: list[str] = []
        # Two separate budgets: redirect hops are normal navigation and must not
        # burn retries (a legitimate http→https→www chain is three hops, not
        # three failures), while every *failure* consumes one of the three
        # attempts before the caller is told the host is unhealthy.
        retries_used = 0
        hops = 0
        max_hops = _MAX_ATTEMPTS + spec.max_redirects + 2

        while True:
            hops += 1
            if hops > max_hops:
                raise FetchFailed(
                    "Request exceeded the hop budget",
                    details={"hops": hops, "max_hops": max_hops},
                )

            try:
                async with domain_gate.hold(target.registrable_hint):
                    response, body, raw_bytes = await self._single_request(
                        target, headers, spec, proxy, deadline
                    )
            except (FetchTimeout, ResponseTooLarge, UnsupportedContentType, SSRFBlocked):
                raise  # deterministic: retrying will not help
            except (httpx.TransportError, FetchFailed):
                retries_used += 1
                if retries_used >= _MAX_ATTEMPTS:
                    raise
                # Exponential backoff with jitter: avoids synchronised retries
                # across workers all hammering a struggling host at once.
                await asyncio.sleep(min(2 ** retries_used * 0.25, 4.0) * (0.5 + random.random()))
                continue

            http_status = response.status_code

            # --- redirects: re-validate every hop -------------------------
            if http_status in (301, 302, 303, 307, 308) and spec.follow_redirects:
                if len(redirect_chain) >= spec.max_redirects:
                    raise FetchFailed(
                        "Too many redirects",
                        details={"max_redirects": spec.max_redirects, "chain": redirect_chain},
                    )
                location = response.headers.get("location")
                if not location:
                    raise FetchFailed("Redirect response without a Location header")
                next_url = urljoin(target.url, location)
                redirect_chain.append(next_url)
                target = await validate_url(next_url)   # SSRF re-check, incl. DNS
                continue

            # A retryable status with budget left is retried; with budget spent
            # it falls through and is returned as a normal http_error, so the
            # caller sees the real status code rather than a generic exception.
            if http_status in _RETRY_STATUS and retries_used < _MAX_ATTEMPTS - 1:
                retries_used += 1
                retry_after = response.headers.get("retry-after") or ""
                wait = min(float(retry_after), 10.0) if retry_after.isdigit() else min(1.5 * retries_used, 5.0)
                logger.info(
                    "Retrying after HTTP %s",
                    http_status,
                    extra={"url": target.url, "status_code": http_status},
                )
                await asyncio.sleep(wait)
                continue

            content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
            duration_ms = int((time.perf_counter() - started) * 1000)

            if http_status >= 400:
                return FetchResult(
                    url=url, final_url=target.url, status="http_error", http_status=http_status,
                    content_type=content_type, body="", body_bytes=len(body), duration_ms=duration_ms,
                    headers=dict(response.headers), redirect_chain=redirect_chain,
                    error_code=f"http_{http_status}",
                    error_message=f"Target returned HTTP {http_status}",
                )

            if content_type and not any(content_type.startswith(t) for t in TEXTUAL_CONTENT_TYPES):
                raise UnsupportedContentType(
                    f"Content type '{content_type}' is not extractable",
                    details={"content_type": content_type},
                )

            text = decode_body(body, content_type) if body else ""
            return FetchResult(
                url=url,
                final_url=target.url,
                status="ok",
                http_status=http_status,
                content_type=content_type,
                body=text,
                body_bytes=raw_bytes,
                duration_ms=duration_ms,
                fetch_method="http",
                headers={k.lower(): v for k, v in response.headers.items()},
                redirect_chain=redirect_chain,
            )
        # The loop above only exits by returning a result or by raising, so
        # there is no fall-through case to handle here.

    # ------------------------------------------------------------------
    async def _single_request(
        self,
        target: ValidatedTarget,
        headers: dict[str, str],
        spec: FetchSpec,
        proxy: str | None,
        deadline: float,
    ) -> tuple[httpx.Response, bytes, int]:
        """One hop. Returns (response, decoded-body, raw-byte-count)."""
        client = await self._client_for(proxy)
        limit = min(spec.max_bytes, settings.max_response_bytes)
        request = build_pinned_request(client, "GET", target, headers)

        timeout_left = deadline - time.perf_counter()
        if timeout_left <= 0:
            raise FetchTimeout("Deadline exceeded before the request started")

        try:
            response = await asyncio.wait_for(client.send(request, stream=True), timeout=timeout_left)
        except TimeoutError as exc:
            raise FetchTimeout(
                f"Request exceeded {spec.timeout_ms} ms",
                details={"url": target.url, "timeout_ms": spec.timeout_ms},
            ) from exc
        except httpx.ConnectError as exc:
            raise FetchFailed(
                "Could not connect to the target",
                details={"url": target.url, "reason": type(exc).__name__},
            ) from exc
        except httpx.HTTPError as exc:
            raise FetchFailed("Transport error", details={"url": target.url}) from exc

        # A declared Content-Length far beyond our cap is rejected up front,
        # before a single body byte is read.
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit * 4:
            await response.aclose()
            raise ResponseTooLarge(
                "Response declares a size beyond the configured limit",
                details={"content_length": int(declared), "limit_bytes": limit},
            )

        chunks: list[bytes] = []
        total = 0
        try:
            async for chunk in response.aiter_raw():
                total += len(chunk)
                # Raw ceiling: a huge *compressed* body is already abusive.
                if total > limit * 4:
                    await response.aclose()
                    raise ResponseTooLarge(
                        "Response body exceeded the configured limit",
                        details={"limit_bytes": limit, "received_bytes": total},
                    )
                chunks.append(chunk)
                if time.perf_counter() > deadline:
                    await response.aclose()
                    raise FetchTimeout("Response body read exceeded the deadline")
        except httpx.HTTPError as exc:
            raise FetchFailed("Body read failed", details={"url": target.url}) from exc
        finally:
            await response.aclose()

        raw = b"".join(chunks)
        encoding = response.headers.get("content-encoding", "")

        if encoding and encoding.lower().strip() not in ("identity", ""):
            body = _decompress(raw, encoding, limit)
            # Belt and braces: an expansion ratio well beyond normal text
            # compression is a bomb even when it technically fits the limit.
            if raw and len(body) / max(len(raw), 1) > settings.max_decompression_ratio:
                raise ResponseTooLarge(
                    "Decompression ratio exceeded the safety threshold",
                    details={"ratio": round(len(body) / max(len(raw), 1), 1),
                             "max_ratio": settings.max_decompression_ratio},
                )
        else:
            body = raw

        if len(body) > limit:
            raise ResponseTooLarge(
                "Decoded body exceeded the configured limit",
                details={"limit_bytes": limit, "size": len(body)},
            )

        return response, body, total


# Process-wide fetcher instance.
http_fetcher = HttpFetcher()
