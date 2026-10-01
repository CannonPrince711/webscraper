"""Page metadata: Open Graph, Twitter cards, standard meta, JSON-LD.

Structured metadata is the highest-signal, lowest-cost extraction source on the
web: a product page that publishes `application/ld+json` with a `Product` node
gives exact prices and SKUs for free, with no selectors and no LLM. Every
extraction strategy consults it first.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from typing import Any

from ..core.text import absolutize, clean_text, parse_date, truncate
from .dom import Dom

logger = logging.getLogger(__name__)

_MAX_JSON_LD_BLOCKS = 50
_MAX_JSON_LD_BYTES = 512_000

# Meta names worth carrying through; anything else is noise (or tracking).
_META_KEYS: tuple[str, ...] = (
    "description", "keywords", "author", "robots", "viewport", "theme-color",
    "application-name", "generator", "referrer", "publisher",
    "article:author", "article:published_time", "article:modified_time",
    "article:section", "article:tag", "product:price:amount", "product:price:currency",
)

_OG_KEYS: tuple[str, ...] = (
    "og:title", "og:description", "og:type", "og:url", "og:site_name",
    "og:image", "og:image:width", "og:image:height", "og:image:alt",
    "og:locale", "og:price:amount", "og:price:currency",
    "og:availability", "og:video", "og:audio",
)

_TWITTER_KEYS: tuple[str, ...] = (
    "twitter:title", "twitter:description", "twitter:image", "twitter:card",
    "twitter:site", "twitter:creator",
)


def _meta_map(dom: Dom) -> dict[str, str]:
    """Collect <meta> content by name/property/itemprop, first value wins."""
    out: dict[str, str] = {}
    for node in dom.css("meta", limit=400):
        content = node.attr("content") or node.attr("value")
        if not content:
            continue
        for key_attr in ("property", "name", "itemprop"):
            key = node.attr(key_attr)
            if not key:
                continue
            normalized = key.strip().lower()
            if normalized and normalized not in out:
                out[normalized] = clean_text(content)
    return out


def extract_json_ld(dom: Dom) -> list[dict[str, Any]]:
    """Parse every `application/ld+json` block. Malformed blocks are skipped."""
    blocks: list[dict[str, Any]] = []
    for node in dom.css("script[type='application/ld+json']", limit=_MAX_JSON_LD_BLOCKS):
        raw = node.inner_html()
        if not raw or len(raw) > _MAX_JSON_LD_BYTES:
            continue
        text = raw.strip()
        # Some sites wrap the payload in a CDATA-ish comment.
        text = text.removeprefix("<!--").removesuffix("-->").strip()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            # A truncated or concatenated block: try to salvage the first object.
            start, end = text.find("{"), text.rfind("}")
            if start == -1 or end <= start:
                continue
            try:
                payload = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                logger.debug("Skipping malformed JSON-LD block")
                continue
        for item in payload if isinstance(payload, list) else [payload]:
            if isinstance(item, dict):
                blocks.append(item)
    return blocks


def flatten_json_ld(blocks: Iterable[dict[str, Any]], *, max_depth: int = 6) -> list[dict[str, Any]]:
    """Flatten @graph containers into a flat list, preserving @type."""
    out: list[dict[str, Any]] = []
    seen: set[int] = set()

    def walk(node: Any, depth: int) -> None:
        if depth > max_depth:
            return
        if isinstance(node, dict):
            if id(node) in seen:
                return
            seen.add(id(node))
            if "@graph" in node:
                for child in node.get("@graph") or []:
                    walk(child, depth + 1)
            if any(k not in {"@context", "@graph"} for k in node):
                out.append(node)
        elif isinstance(node, list):
            for child in node:
                walk(child, depth + 1)

    for block in blocks:
        walk(block, 0)
    return out


def json_path_get(data: Any, path: str) -> Any:
    """Read a value by dotted path, e.g. ``offers.price`` or ``author.0.name``.

    Arrays are traversed by index, and a wildcard ``*`` collects the first
    non-null value from every element — which is how you read
    ``offers.*.price`` from a page that sometimes publishes a list.
    """
    if data is None or not path:
        return None
    current: Any = data
    for raw_part in path.strip().split("."):
        part = raw_part.strip()
        if not part:
            continue
        index: int | None = None
        if "[" in part and part.endswith("]"):
            name, _, idx = part[:-1].partition("[")
            part = name
            try:
                index = int(idx)
            except ValueError:
                index = None

        if part == "*":
            if isinstance(current, list):
                collected = [json_path_get(item, "." + ".") for item in current]
                values = [v for v in collected if v is not None]
                current = values[0] if values else None
            continue

        if part:
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list):
                current = None
            else:
                return None

        if index is not None:
            if isinstance(current, list) and -len(current) <= index < len(current):
                current = current[index]
            else:
                return None

        if current is None:
            return None
    return current


def find_json_ld_by_type(blocks: Iterable[dict[str, Any]], type_names: Iterable[str]) -> list[dict[str, Any]]:
    """All flattened nodes whose @type intersects `type_names` (case-insensitive)."""
    wanted = {t.lower() for t in type_names}
    out: list[dict[str, Any]] = []
    for node in flatten_json_ld(blocks):
        raw_type = node.get("@type")
        types: list[str] = []
        if isinstance(raw_type, str):
            types = [raw_type]
        elif isinstance(raw_type, list):
            types = [str(t) for t in raw_type]
        if any(t.lower() in wanted for t in types):
            out.append(node)
    return out


def json_ld_search(blocks: Iterable[dict[str, Any]], path: str) -> Any:
    """Search every node (and its nested lists) for the first non-null value."""
    if not path:
        return None
    for node in flatten_json_ld(blocks):
        # Direct hit on the node itself?
        value = json_path_get(node, path)
        if value is not None:
            return value

        # Try relative to well-known sub-objects (offers, aggregateRating…).
        root = path.split(".", 1)[0]
        for container_key in ("offers", "aggregateRating", "brand", "author", "itemListElement", "mainEntity"):
            container = node.get(container_key)
            if container is None:
                continue
            if isinstance(container, list):
                for item in container:
                    value = json_path_get(item, path if path.startswith(root) else path)
                    if value is not None:
                        return value
            else:
                value = json_path_get(container, path)
                if value is not None:
                    return value
    return None


def extract_metadata(dom: Dom, base_url: str) -> dict[str, Any]:
    """Everything we can say about the page without any selectors."""
    meta = _meta_map(dom)
    json_ld = flatten_json_ld(extract_json_ld(dom))

    canonical = None
    canonical_node = dom.css_first("link[rel='canonical']")
    if canonical_node:
        canonical = absolutize(canonical_node.attr("href"), base_url)

    images: list[str] = []
    for key in ("og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"):
        candidate = absolutize(meta.get(key), base_url)
        if candidate and candidate not in images:
            images.append(candidate)

    favicon = None
    for selector in ("link[rel='icon']", "link[rel='shortcut icon']", "link[rel='apple-touch-icon']"):
        node = dom.css_first(selector)
        if node:
            favicon = absolutize(node.attr("href"), base_url)
            if favicon:
                break

    published = meta.get("article:published_time") or meta.get("datepublished") or meta.get("date")
    modified = meta.get("article:modified_time") or meta.get("datemodified")

    # JSON-LD frequently carries better values than the meta tags.
    ld_title = json_ld_search(json_ld, "headline") or json_ld_search(json_ld, "name")
    ld_description = json_ld_search(json_ld, "description")
    ld_author = json_ld_search(json_ld, "author.name")
    ld_published = json_ld_search(json_ld, "datePublished")
    ld_modified = json_ld_search(json_ld, "dateModified")
    ld_site = json_ld_search(json_ld, "publisher.name")

    return {
        "title": clean_text(meta.get("og:title") or ld_title or dom.title() or "")[:500] or None,
        "description": truncate(clean_text(meta.get("og:description") or meta.get("description") or ld_description or ""), 1000) or None,
        "site_name": clean_text(meta.get("og:site_name") or ld_site or "")[:200] or None,
        "canonical_url": canonical,
        "og_type": meta.get("og:type"),
        "locale": meta.get("og:locale"),
        "author": clean_text(meta.get("author") or meta.get("article:author") or ld_author or "")[:200] or None,
        "published_at": parse_date(published) or parse_date(ld_published, iso=False),
        "modified_at": parse_date(modified) or parse_date(ld_modified, iso=False),
        "keywords": [k.strip() for k in (meta.get("keywords") or "").split(",") if k.strip()][:25],
        "tags": [t.strip() for t in (meta.get("article:tag") or "").split(",") if t.strip()][:25],
        "section": meta.get("article:section"),
        "robots": meta.get("robots"),
        "images": images[:10],
        "favicon": favicon,
        "price": meta.get("product:price:amount") or meta.get("og:price:amount"),
        "currency": meta.get("product:price:currency") or meta.get("og:price:currency"),
        "availability": meta.get("og:availability"),
        "lang": dom.lang(),
        "raw_meta": {k: v for k, v in meta.items() if k in _META_KEYS or k in _OG_KEYS or k in _TWITTER_KEYS},
        "json_ld_types": sorted({str(n.get("@type")) for n in json_ld if n.get("@type")}),
    }


def extract_open_graph(dom: Dom, base_url: str) -> dict[str, str]:
    meta = _meta_map(dom)
    out: dict[str, str] = {}
    for key in _OG_KEYS + _TWITTER_KEYS:
        value = meta.get(key)
        if not value:
            continue
        if "image" in key or key.endswith(":url"):
            value = absolutize(value, base_url) or value
        out[key] = value
    return out
