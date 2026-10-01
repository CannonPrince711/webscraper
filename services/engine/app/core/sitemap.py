"""Sitemap discovery and parsing.

Sitemaps are the cheapest possible crawl seed: the site operator has already
told us which URLs exist and when they changed, so we can skip link discovery
entirely. Supports `<urlset>`, `<sitemapindex>` (nested), plain-text sitemaps,
and gzipped payloads.
"""

from __future__ import annotations

import gzip
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from xml.etree import ElementTree

from ..core.text import clean_text, parse_date

logger = logging.getLogger(__name__)

_NS = re.compile(r"^\{.*\}")
MAX_ENTRIES = 50_000


@dataclass(slots=True)
class SitemapEntry:
    url: str
    lastmod: datetime | None = None
    changefreq: str | None = None
    priority: float | None = None


@dataclass(slots=True)
class SitemapResult:
    entries: list[SitemapEntry] = field(default_factory=list)
    nested_sitemaps: list[str] = field(default_factory=list)
    truncated: bool = False


def _localname(tag: str) -> str:
    return _NS.sub("", tag)


def decode_sitemap_bytes(payload: bytes) -> str:
    """Decode a sitemap body, transparently handling gzip."""
    if payload[:2] == b"\x1f\x8b":
        try:
            payload = gzip.decompress(payload)
        except OSError as exc:  # pragma: no cover - corrupt archive
            logger.warning("Failed to gunzip sitemap: %s", exc)
            return ""
    for encoding in ("utf-8", "latin-1"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("utf-8", errors="replace")


def parse_sitemap(body: str) -> SitemapResult:
    """Parse sitemap XML or plain text. Never raises on malformed input."""
    result = SitemapResult()
    text = body.lstrip("\ufeff \t\r\n")
    if not text:
        return result

    # Plain-text sitemap: one absolute URL per line.
    if not text.startswith("<"):
        for line in text.splitlines():
            candidate = line.strip()
            if candidate.startswith(("http://", "https://")):
                result.entries.append(SitemapEntry(url=candidate))
                if len(result.entries) >= MAX_ENTRIES:
                    result.truncated = True
                    break
        return result

    try:
        root = ElementTree.fromstring(text)  # noqa: S314 - sitemap XML has no
        # External entity expansion is disabled by default in ElementTree and we
        # only read text nodes; entity-heavy payloads are additionally blocked by
        # the byte cap in the fetcher.
    except ElementTree.ParseError as exc:
        logger.warning("Malformed sitemap XML: %s", exc)
        return result

    root_name = _localname(root.tag).lower()
    for child in root:
        name = _localname(child.tag).lower()
        if name == "sitemap":
            loc = child.findtext("{*}loc") or child.findtext("loc")
            if loc:
                result.nested_sitemaps.append(clean_text(loc))
        elif name == "url":
            loc = child.findtext("{*}loc") or child.findtext("loc")
            if not loc:
                continue
            entry = SitemapEntry(url=clean_text(loc))
            lastmod = child.findtext("{*}lastmod") or child.findtext("lastmod")
            if lastmod:
                parsed = parse_date(lastmod, iso=False)
                if parsed:
                    try:
                        entry.lastmod = datetime.fromisoformat(parsed)
                    except ValueError:
                        entry.lastmod = None
            freq = child.findtext("{*}changefreq") or child.findtext("changefreq")
            entry.changefreq = clean_text(freq) or None
            priority = child.findtext("{*}priority") or child.findtext("priority")
            if priority:
                try:
                    entry.priority = float(priority)
                except ValueError:
                    entry.priority = None
            result.entries.append(entry)
            if len(result.entries) >= MAX_ENTRIES:
                result.truncated = True
                break

    if root_name == "urlset" and not result.entries:
        logger.warning("Sitemap urlset contained no <url> entries")

    return result


def sitemap_urls_from_robots(sitemap_directives: tuple[str, ...], fallback_origin: str) -> list[str]:
    """Sitemap locations from robots.txt, falling back to the conventions."""
    if sitemap_directives:
        return list(dict.fromkeys(sitemap_directives))
    return [f"{fallback_origin}/sitemap.xml", f"{fallback_origin}/sitemap_index.xml"]
