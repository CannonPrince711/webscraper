"""Fetch orchestration: choose between HTTP and browser per page.

`render: "auto"` is the default and the interesting case. Static pages — still
the majority of the web — are served by the cheap HTTP path. When the response
looks like an unhydrated SPA shell, the engine escalates to Chromium rather
than returning an empty extraction and letting the user conclude the scraper
is broken.

The heuristic is deliberately conservative: a false positive costs one browser
render, a false negative costs a silently empty result, which is far worse.
"""

from __future__ import annotations

import logging
import re

from ..config import settings
from ..errors import BrowserUnavailable
from ..models import FetchResult, FetchSpec, RenderMode
from .browser import browser_fetcher
from .http import http_fetcher

logger = logging.getLogger(__name__)

_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_BLOCK_RE = re.compile(r"(?is)<script.*?</script>")
_STYLE_BLOCK_RE = re.compile(r"(?is)<style.*?</style>")
_WS_RE = re.compile(r"\s+")

# Phrases that mean "this page needs JS to render".
_JS_REQUIRED_MARKERS: tuple[str, ...] = (
    "you need to enable javascript",
    "please enable javascript",
    "enable javascript to continue",
    "javascript is required",
    "javascript is disabled",
    "this app requires javascript",
    "activate javascript",
)

# Empty mount points left behind by common frameworks before hydration.
_EMPTY_MOUNT_RE = re.compile(
    r"""<div[^>]+id=["'](root|app|__next|__nuxt|react-root|mount|q-app)["'][^>]*>\s*</div>""",
    re.IGNORECASE,
)

_MIN_VISIBLE_TEXT = 400


def visible_text_length(html: str) -> int:
    """Approximate length of user-visible text in a document."""
    if not html:
        return 0
    stripped = _SCRIPT_BLOCK_RE.sub(" ", html)
    stripped = _STYLE_BLOCK_RE.sub(" ", stripped)
    stripped = _TAG_RE.sub(" ", stripped)
    return len(_WS_RE.sub(" ", stripped).strip())


def looks_like_unrendered_spa(html: str) -> tuple[bool, str]:
    """Decide whether a static fetch should be retried with a browser."""
    if not html or len(html) < 64:
        return True, "empty_body"

    lowered = html.lower()
    for marker in _JS_REQUIRED_MARKERS:
        if marker in lowered:
            return True, f"js_notice:{marker[:24]}"

    if _EMPTY_MOUNT_RE.search(html) and visible_text_length(html) < _MIN_VISIBLE_TEXT:
        return True, "empty_mount_point"

    # A document that is mostly <script> with almost no text is a shell.
    total = len(html)
    script_bytes = sum(len(m.group(0)) for m in _SCRIPT_BLOCK_RE.finditer(html))
    if total > 2000 and script_bytes / total > 0.55 and visible_text_length(html) < _MIN_VISIBLE_TEXT:
        return True, "script_dominated"

    return False, ""


async def fetch_page(url: str, spec: FetchSpec, *, depth: int = 0) -> FetchResult:
    """Fetch one URL, honouring the configured render strategy."""
    if spec.render == RenderMode.HTTP:
        return await http_fetcher.fetch(url, spec, depth=depth)

    if spec.render == RenderMode.JS:
        if not settings.enable_browser:
            raise BrowserUnavailable(
                "render='js' was requested but browser rendering is disabled on this engine"
            )
        return await browser_fetcher.fetch(url, spec, depth=depth)

    # --- auto ---
    result = await http_fetcher.fetch(url, spec, depth=depth)

    if result.status != "ok" or not result.body:
        return result

    needs_browser, reason = looks_like_unrendered_spa(result.body)
    if not needs_browser:
        return result

    if not settings.enable_browser:
        result.headers["x-render-hint"] = f"spa_suspected:{reason}"
        return result

    logger.info("Escalating to browser", extra={"url": url, "status_code": None})
    try:
        rendered = await browser_fetcher.fetch(url, spec, depth=depth)
    except Exception as exc:  # noqa: BLE001 - degrade, never fail the page
        # A browser problem must not turn a working scrape into an error: the
        # static result is returned with a hint explaining what happened.
        logger.warning("Browser escalation failed, keeping the static result: %s", type(exc).__name__)
        result.headers["x-render-hint"] = f"browser_failed:{type(exc).__name__}"
        return result

    # Keep whichever version actually has content — some "SPAs" render less than
    # the static HTML they shipped.
    if visible_text_length(rendered.body) >= visible_text_length(result.body):
        rendered.redirect_chain = result.redirect_chain
        return rendered

    result.headers["x-render-hint"] = "browser_rendered_less"
    return result


async def close_fetchers() -> None:
    """Release pooled connections and the browser on shutdown."""
    await http_fetcher.aclose()
    await browser_fetcher.aclose()
