"""Headless-Chromium fetcher for JavaScript-rendered pages.

Cost model: a browser render is roughly 50–200× the CPU and ~300× the memory
of an HTTP fetch, so this path is opt-in (`render: "js"`) or escalated to only
when the static HTML looks like an unresolved SPA shell.

Network safety: Chromium resolves DNS itself, so the SSRF guard used by the
HTTP path does not automatically apply inside the page. Every request the
browser makes — navigation, XHR, images — is therefore intercepted in
`_guard_route` and validated, with a short-lived per-host verdict cache so a
page with 300 assets does not trigger 300 DNS lookups.

Residual risk (documented in docs/SECURITY.md): a DNS rebinding attack that
changes an answer between our interception and Chromium's own resolution. It is
mitigated out-of-band by running the engine in a container whose egress is
restricted to the public internet and whose metadata endpoint is unreachable.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from urllib.parse import urlsplit

from ..config import settings
from ..core.ssrf import parse_and_validate_url, resolve_host
from ..errors import BrowserUnavailable, FetchFailed, FetchTimeout, ResponseTooLarge, SSRFBlocked
from ..models import DeviceProfile, FetchResult, FetchSpec
from .proxies import resolve_proxy, split_proxy_url

logger = logging.getLogger(__name__)

_DEVICE_PROFILES: dict[DeviceProfile, dict[str, object]] = {
    DeviceProfile.DESKTOP: {
        "viewport": {"width": 1440, "height": 900},
        "user_agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "device_scale_factor": 1,
        "is_mobile": False,
    },
    DeviceProfile.MOBILE: {
        "viewport": {"width": 390, "height": 844},
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
        ),
        "device_scale_factor": 3,
        "is_mobile": True,
    },
    DeviceProfile.TABLET: {
        "viewport": {"width": 820, "height": 1180},
        "user_agent": (
            "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
        ),
        "device_scale_factor": 2,
        "is_mobile": True,
    },
}

# Resource types that never affect extracted data but dominate page weight.
_BLOCKED_RESOURCE_TYPES = {"image", "media", "font", "stylesheet", "other"}

_CHROMIUM_ARGS = [
    "--disable-dev-shm-usage",          # containers have a small /dev/shm
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-extensions",
    "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,Translate,BackForwardCache",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-notifications",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--force-color-profile=srgb",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    "--hide-scrollbars",
    "--no-service-autorun",
    "--export-tagged-pdf",
    "--disable-search-engine-choice-screen",
]

MAX_SCREENSHOT_HEIGHT = 4000


class BrowserFetcher:
    """Lazily-started Chromium pool. Safe to call before Playwright is installed."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(max(1, settings.browser_pool_size))
        self._unavailable_reason: str | None = None
        # host -> (verdict_is_public, checked_at)
        self._host_verdicts: dict[str, tuple[bool, float]] = {}

    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        return settings.enable_browser and self._unavailable_reason is None

    async def _ensure_browser(self):
        if self._browser is not None and self._browser.is_connected():
            return self._browser

        if not settings.enable_browser:
            raise BrowserUnavailable("Browser rendering is disabled (ENGINE_ENABLE_BROWSER=false)")

        async with self._lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:  # pragma: no cover - deployment concern
                self._unavailable_reason = "playwright is not installed"
                raise BrowserUnavailable(
                    "Playwright is not installed in this environment",
                    details={"hint": "pip install playwright && python -m playwright install chromium"},
                ) from exc

            try:
                self._playwright = await async_playwright().start()
                self._browser = await self._playwright.chromium.launch(
                    headless=True,
                    args=_CHROMIUM_ARGS,
                    # Chromium's own proxy support is used only when configured;
                    # per-request proxies are applied at the context level below.
                )
                self._unavailable_reason = None
                logger.info("Chromium started for browser rendering")
            except Exception as exc:  # pragma: no cover - depends on host
                self._unavailable_reason = type(exc).__name__
                raise BrowserUnavailable(
                    "Could not launch Chromium",
                    details={"reason": type(exc).__name__},
                ) from exc
            return self._browser

    async def aclose(self) -> None:
        async with self._lock:
            if self._browser is not None:
                try:
                    await self._browser.close()
                except Exception:  # pragma: no cover
                    pass
                self._browser = None
            if self._playwright is not None:
                try:
                    await self._playwright.stop()
                except Exception:  # pragma: no cover
                    pass
                self._playwright = None

    # ------------------------------------------------------------------
    async def _is_request_allowed(self, url: str) -> tuple[bool, str]:
        """Validate a browser sub-request. Cached per host for 60s."""
        try:
            parts = urlsplit(url)
        except ValueError:
            return False, "unparseable_url"

        if parts.scheme not in {"http", "https", ""}:
            return False, f"scheme_{parts.scheme}"

        host = (parts.hostname or "").lower()
        now = time.time()
        cached = self._host_verdicts.get(host)
        if cached and now - cached[1] < 60:
            return cached[0], "cached"

        try:
            target = parse_and_validate_url(url)
        except SSRFBlocked as exc:
            self._host_verdicts[host] = (False, now)
            return False, exc.details.get("reason", "blocked")

        # Resolve and check, unless the host was already validated for the main
        # navigation (the common case for assets).
        literals = target.resolved_ips
        if not literals:
            from ..core.ssrf import is_blocked_ip  # local import keeps the hot path tidy

            ips = await resolve_host(target.host)
            if not ips or any(is_blocked_ip(ip) for ip in ips):
                self._host_verdicts[host] = (False, now)
                return False, "private_network"

        self._host_verdicts[host] = (True, now)
        return True, "allowed"

    async def _guard_route(self, route, request, *, block_assets: bool = True) -> None:
        """Intercept every request the page makes and enforce the SSRF policy."""
        try:
            allowed, reason = await self._is_request_allowed(request.url)
            if not allowed:
                logger.warning(
                    "Blocked a browser request",
                    extra={"url": request.url, "error_code": reason},
                )
                await route.abort("blockedbyclient")
                return

            if block_assets and request.resource_type in _BLOCKED_RESOURCE_TYPES:
                # Stylesheets are blocked by default: they cost bandwidth and
                # cannot affect the DOM text we extract. The visual picker
                # disables this so the preview renders as a human sees it.
                await route.abort()
                return

            await route.continue_()
        except Exception as exc:  # never let a routing error leak the request
            logger.debug("Route handler error: %s", type(exc).__name__)
            try:
                await route.abort()
            except Exception:
                pass

    # ------------------------------------------------------------------
    async def fetch(self, url: str, spec: FetchSpec, *, depth: int = 0) -> FetchResult:
        started = time.perf_counter()
        browser = await self._ensure_browser()

        allowed, reason = await self._is_request_allowed(url)
        if not allowed:
            raise SSRFBlocked("Refusing to render an internal address", details={"reason": reason})

        profile = _DEVICE_PROFILES.get(spec.device, _DEVICE_PROFILES[DeviceProfile.DESKTOP])
        viewport = {
            "width": spec.viewport_width or int(profile["viewport"]["width"]),  # type: ignore[index]
            "height": spec.viewport_height or int(profile["viewport"]["height"]),  # type: ignore[index]
        }

        # Resolution happens once per page: it validates the policy and fails
        # fast (before Chromium starts) if the provider is not configured.
        decision = resolve_proxy(spec.proxy)
        context_proxy = split_proxy_url(decision.url) if decision.url else None
        if decision.warnings:
            logger.warning("Proxy policy warning: %s", decision.warnings[0], extra={"url": url})

        context = None
        page = None
        async with self._semaphore:
            try:
                context = await browser.new_context(
                    viewport=viewport,
                    # Playwright takes the proxy per context, so a job that asks
                    # for residential IPs renders *through* them too — the whole
                    # point of using a proxy on a JavaScript-heavy site.
                    proxy=context_proxy,
                    user_agent=spec.user_agent or str(profile["user_agent"]),
                    device_scale_factor=float(profile["device_scale_factor"]),  # type: ignore[arg-type]
                    is_mobile=bool(profile["is_mobile"]),
                    has_touch=bool(profile["is_mobile"]),
                    locale="en-US",
                    timezone_id="UTC",
                    java_script_enabled=True,
                    bypass_csp=False,
                    ignore_https_errors=False,
                    extra_http_headers={k: v for k, v in spec.headers.items()} if spec.headers else {},
                )
                # Route interception is our only in-browser SSRF choke point, so
                # it is registered before any navigation happens. Assets are
                # skipped unless the caller asked for a faithful visual render.
                await context.route(
                    "**/*",
                    lambda route, request: self._guard_route(  # type: ignore[misc]
                        route, request, block_assets=spec.block_assets
                    ),
                )
                # Service workers would bypass route interception for cached
                # sub-resources, so they are disabled outright.
                await context.add_init_script(
                    "if (navigator.serviceWorker) { navigator.serviceWorker.register = () => Promise.reject(new Error('blocked')); }"
                )
                await context.add_init_script(
                    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
                )

                page = await context.new_page()
                page.set_default_timeout(spec.timeout_ms)
                page.set_default_navigation_timeout(spec.timeout_ms)

                response = await page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=spec.timeout_ms,
                    referer=spec.referer or None,
                )

                await self._wait_for_content(page, spec)

                html = await page.content()
                if len(html.encode("utf-8")) > spec.max_bytes:
                    raise ResponseTooLarge(
                        "Rendered HTML exceeded the configured limit",
                        details={"limit_bytes": spec.max_bytes},
                    )

                screenshot: bytes | None = None
                if spec.screenshot:
                    try:
                        screenshot = await page.screenshot(
                            full_page=False,          # bounded size, deterministic timing
                            type="png",
                            animations="disabled",
                            caret="hide",
                        )
                    except Exception as exc:  # pragma: no cover - best effort
                        logger.debug("Screenshot failed: %s", type(exc).__name__)

                http_status = response.status if response else None
                duration_ms = int((time.perf_counter() - started) * 1000)

                return FetchResult(
                    url=url,
                    final_url=page.url,
                    status="ok" if (http_status is None or http_status < 400) else "http_error",
                    http_status=http_status,
                    content_type="text/html",
                    body=html,
                    body_bytes=len(html.encode("utf-8")),
                    duration_ms=duration_ms,
                    fetch_method="browser",
                    rendered=True,
                    headers=dict(response.headers) if response else {},
                    screenshot_png=screenshot,
                    error_code=None if (http_status is None or http_status < 400) else f"http_{http_status}",
                )
            except SSRFBlocked:
                raise
            except ResponseTooLarge:
                raise
            except Exception as exc:
                name = type(exc).__name__
                if "Timeout" in name:
                    raise FetchTimeout(
                        f"Page did not finish rendering within {spec.timeout_ms} ms",
                        details={"url": url},
                    ) from exc
                raise FetchFailed(
                    "Browser render failed",
                    details={"url": url, "reason": name},
                ) from exc
            finally:
                for closable in (page, context):
                    if closable is None:
                        continue
                    try:
                        await closable.close()
                    except Exception:  # pragma: no cover
                        pass

    # ------------------------------------------------------------------
    async def _wait_for_content(self, page, spec: FetchSpec) -> None:
        """Best-effort wait for the page to finish its client-side render."""
        wait_for = (spec.wait_for or "").strip()
        if wait_for:
            if wait_for.isdigit():
                await page.wait_for_timeout(min(int(wait_for), spec.timeout_ms))
            else:
                try:
                    await page.wait_for_selector(wait_for, timeout=min(spec.timeout_ms, 15_000), state="attached")
                except Exception:
                    # Not fatal: the selector may be optional, and a slow render
                    # is still worth extracting whatever did appear.
                    logger.debug("wait_for selector did not appear", extra={"url": page.url})
            return

        # Default: give the network a short, bounded chance to settle. Networkidle
        # never fires on sites with polling, so it is capped well below timeout.
        try:
            await page.wait_for_load_state("networkidle", timeout=min(spec.timeout_ms, 5_000))
        except Exception:
            pass
        try:
            await page.wait_for_timeout(250)   # let a final paint/layout pass land
        except Exception:  # pragma: no cover
            pass


browser_fetcher = BrowserFetcher()


def screenshot_to_base64(png: bytes | None) -> str | None:
    if not png:
        return None
    return base64.b64encode(png).decode("ascii")
