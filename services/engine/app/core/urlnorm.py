"""URL and content normalisation — the basis of crawl de-duplication.

A crawler's correctness depends on answering "have I seen this already?" the
same way twice. `https://Shop.example.com/p/1?utm_source=x#reviews` and
`https://shop.example.com/p/1/` are the same page; without normalisation a
crawl loops forever or burns its budget on query-string permutations.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Marketing/analytics parameters that never change the served content.
TRACKING_PARAMS: frozenset[str] = frozenset(
    {
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "utm_id", "utm_name", "utm_cid", "utm_reader", "utm_referrer",
        "gclid", "gclsrc", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
        "yclid", "twclid", "igshid", "vero_id", "_ga", "_gl", "ref", "ref_src",
        "spm", "scm", "si", "trk", "trkCampaign", "wickedid", "oly_anon_id",
        "oly_enc_id", "sessionid", "phpsessid", "sid",
    }
)

# Extensions that are never crawlable documents.
NON_DOCUMENT_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".svg", ".ico",
        ".css", ".js", ".mjs", ".map", ".json", ".xml", ".rss", ".atom",
        ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z", ".bz2", ".xz",
        ".mp3", ".wav", ".ogg", ".mp4", ".mov", ".avi", ".webm", ".mkv",
        ".woff", ".woff2", ".ttf", ".otf", ".eot",
        ".exe", ".dmg", ".pkg", ".deb", ".rpm", ".apk", ".msi",
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    }
)

_DEFAULT_PORTS = {"http": "80", "https": "443"}


def normalize_url(
    url: str,
    *,
    strip_tracking: bool = True,
    strip_fragment: bool = True,
    sort_query: bool = True,
    strip_trailing_slash: bool = True,
) -> str:
    """Return the canonical form of a URL for de-duplication.

    Never raises: an unparseable input is returned stripped, so the caller can
    decide whether to drop it (the SSRF guard will reject it later anyway).
    """
    if not url:
        return ""
    raw = url.strip()
    if "://" not in raw:
        raw = "https://" + raw

    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw

    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower().rstrip(".")

    netloc = host
    port = parts.port
    if port is not None and str(port) != _DEFAULT_PORTS.get(scheme, ""):
        netloc = f"{netloc}:{port}"

    path = parts.path or "/"
    # Collapse duplicate slashes but preserve the protocol-relative case.
    path = re.sub(r"/{2,}", "/", path)
    if strip_trailing_slash and len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    # Strip common index documents.
    for index_name in ("/index.html", "/index.htm", "/index.php", "/default.html"):
        if path.endswith(index_name):
            path = path[: -len(index_name)] or "/"
            break

    query = parts.query
    if query:
        pairs = parse_qsl(query, keep_blank_values=True)
        if strip_tracking:
            pairs = [(k, v) for k, v in pairs if k.lower() not in TRACKING_PARAMS]
        if sort_query:
            pairs.sort()
        query = urlencode(pairs, doseq=True)

    fragment = "" if strip_fragment else parts.fragment
    return urlunsplit((scheme, netloc, path, query, fragment))


def url_hash(url: str) -> str:
    """Stable hash of the normalised URL (used as `pages.url_hash`)."""
    return hashlib.sha256(normalize_url(url).encode("utf-8")).hexdigest()


def content_hash(value: Any) -> str:
    """Hash of extracted data, canonicalised so key order cannot matter.

    This is the dedupe key for `records` and the change-detection key for
    `monitors`: two runs over an unchanged page produce identical hashes and
    therefore zero "changed" rows.
    """
    canonical = json.dumps(value, sort_keys=True, default=str, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def has_document_extension(url: str) -> bool:
    """True when the URL path ends in something we should not treat as a page."""
    path = urlsplit(url).path.lower()
    for ext in NON_DOCUMENT_EXTENSIONS:
        if path.endswith(ext):
            return True
    return False


def same_site(left: str, right: str) -> bool:
    """Compare registrable domains without pulling in the full public suffix list."""
    from .ssrf import parse_and_validate_url

    try:
        a = parse_and_validate_url(left).registrable_hint
        b = parse_and_validate_url(right).registrable_hint
    except Exception:
        return False
    return a == b


def path_matches_any(path: str, patterns: Iterable[str]) -> bool:
    """Glob-ish matcher for crawl include/exclude rules.

    Supports ``*`` (any characters) and a trailing ``/**`` (any descendants),
    which is what users actually type in a UI. Compiled patterns are cached by
    `functools.lru_cache` on the pattern string.
    """
    if not patterns:
        return False
    for pattern in patterns:
        if _glob_to_regex(pattern).match(path):
            return True
    return False


import functools  # noqa: E402  (kept next to its only consumer for readability)


@functools.lru_cache(maxsize=1024)
def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    normalized = pattern.strip()
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    normalized = normalized.replace("/**", "\x00DESCEND\x00")
    escaped = re.escape(normalized).replace(r"\*", "[^/]*")
    escaped = escaped.replace(re.escape("\x00DESCEND\x00"), ".*")
    # An exact pattern also matches the directory itself: /products => /products.
    return re.compile(f"^{escaped}/?$")
