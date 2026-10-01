"""Link discovery — the crawl frontier's input.

Every link on a page is a candidate for the next crawl step, which makes this
the place where a crawl's cost is decided. Three rules keep it sane:

1. **Resolve and normalise** so `?utm_source=` or a trailing slash does not
   create a second node for a page already visited.
2. **Drop non-documents** by extension, so we never spend a fetch on a JPEG.
3. **Annotate, don't decide.** Scope (depth, include/exclude, same-domain) is
   applied by the worker, which owns the crawl policy. This module only reports
   what is on the page, including `rel=nofollow`, `rel=canonical` and
   pagination hints that the policy layer needs.
"""

from __future__ import annotations

import logging
from typing import Any

from ..core.text import clean_text
from ..core.urlnorm import has_document_extension, normalize_url
from .dom import Dom

logger = logging.getLogger(__name__)

_PAGINATION_RELS = {"next", "prev", "last", "first"}
_SITEMAP_RELS = {"sitemap"}
_MAX_LINKS = 5000


def extract_links(dom: Dom, base_url: str) -> list[dict[str, Any]]:
    """All crawlable links on the page, de-duplicated by normalised URL."""
    seen: set[str] = set()
    links: list[dict[str, Any]] = []

    def add(href: str | None, *, text: str = "", rel: str = "", source: str = "a") -> None:
        if not href or len(links) >= _MAX_LINKS:
            return
        raw = href.strip()
        if not raw or raw.startswith(("#", "javascript:", "mailto:", "tel:", "data:", "blob:")):
            return
        try:
            from urllib.parse import urljoin

            absolute = urljoin(base_url, raw)
        except Exception:
            return

        from urllib.parse import urlsplit

        parts = urlsplit(absolute)
        if parts.scheme not in {"http", "https"}:
            return
        if has_document_extension(absolute):
            return

        normalized = normalize_url(absolute)
        if not normalized or normalized in seen:
            return
        seen.add(normalized)

        rel_tokens = {t.lower() for t in rel.split()} if rel else set()
        links.append(
            {
                "url": absolute,
                "normalized_url": normalized,
                "text": clean_text(text)[:200],
                "rel": sorted(rel_tokens),
                "nofollow": "nofollow" in rel_tokens or "ugc" in rel_tokens or "sponsored" in rel_tokens,
                "is_pagination": bool(rel_tokens & _PAGINATION_RELS),
                "source": source,
            }
        )

    for node in dom.css("a[href]", limit=_MAX_LINKS):
        add(node.attr("href"), text=node.text(), rel=node.attr("rel") or "", source="a")

    for node in dom.css("area[href]", limit=500):
        add(node.attr("href"), text=node.text(), rel=node.attr("rel") or "", source="area")

    for node in dom.css("link[rel]", limit=500):
        rel = (node.attr("rel") or "").lower()
        if rel in _SITEMAP_RELS:
            add(node.attr("href"), rel=rel, source="sitemap-link")

    return links


def discover_sitemaps(dom: Dom, base_url: str) -> list[str]:
    """Sitemap URLs declared in the document (`<link rel="sitemap">`)."""
    from ..core.text import absolutize

    found: list[str] = []
    for node in dom.css("link[rel='sitemap'], link[type='application/xml']", limit=50):
        href = absolutize(node.attr("href"), base_url)
        if href and href not in found:
            found.append(href)
    return found


def paginate_hint(links: list[dict[str, Any]]) -> str | None:
    """The `rel=next` target, used to walk list pages without a full crawl."""
    for link in links:
        rel = set(link.get("rel") or [])
        if "next" in rel:
            return link["url"]
    return None
