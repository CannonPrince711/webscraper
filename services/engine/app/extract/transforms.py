"""Field transforms and type coercion.

Two stages, applied in this order:

1. **Transforms** — string-level cleanup declared in the config
   (`trim`, `regex:...`, `replace:...`, `prefix:...`). Predictable, no surprises.
2. **Coercion** — the field's declared `type` decides the final Python type, so
   downstream code (and the CSV exporter) never has to guess.

Every transform is total: a bad pattern or an unexpected input returns the
value unchanged rather than raising. A single malformed cell must not fail a
50,000-record job.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urljoin

from ..core.text import absolutize, clean_text, parse_bool, parse_date, parse_number, strip_html

logger = logging.getLogger(__name__)

_URLISH_RE = re.compile(r"^(https?://|/|\.\.?/)", re.IGNORECASE)
_IMAGE_EXT_RE = re.compile(r"\.(jpe?g|png|gif|webp|avif|svg|bmp)(\?|$)", re.IGNORECASE)


def apply_transforms(value: Any, transforms: list[str], *, base_url: str = "") -> Any:
    """Apply string transforms left to right. Unknown transforms are ignored."""
    if value is None or not transforms:
        return value

    is_list = isinstance(value, list)
    items = value if is_list else [value]
    out: list[Any] = []

    for item in items:
        current: Any = item
        for transform in transforms:
            current = _apply_one(current, transform, base_url)
        out.append(current)

    return out if is_list else out[0]


def _apply_one(value: Any, transform: str, base_url: str) -> Any:
    if value is None:
        return None

    name, _, argument = transform.partition(":")
    name = name.strip().lower()
    text = str(value)

    try:
        if name == "trim":
            return text.strip()
        if name == "collapse":
            return clean_text(text)
        if name == "lower":
            return text.lower()
        if name == "upper":
            return text.upper()
        if name == "title":
            return text.title()
        if name == "strip_html":
            return strip_html(text)
        if name == "number":
            return parse_number(text)
        if name == "integer":
            parsed = parse_number(text)
            return int(parsed) if isinstance(parsed, (int, float)) else None
        if name == "bool":
            return parse_bool(text)
        if name == "date":
            return parse_date(text)
        if name == "length":
            return len(text)
        if name == "absolute_url":
            return absolutize(text, base_url) if base_url else text
        if name == "first_n_chars":
            count = int(argument or "200")
            return text[:count]
        if name == "strip":
            return text.replace(argument, "")
        if name == "prefix":
            return f"{argument}{text}"
        if name == "suffix":
            return f"{text}{argument}"
        if name == "replace":
            old, _, new = argument.partition(":")
            return text.replace(old, new)
        if name == "regex":
            match = re.search(argument, text, re.IGNORECASE)
            if not match:
                return None
            return match.group(1) if match.groups() else match.group(0)
        if name == "split":
            return text.split(argument or ",")
        if name in {"first", "last"}:
            parts = [p.strip() for p in text.split(argument or ",")]
            if not parts:
                return value
            return parts[0] if name == "first" else parts[-1]
        if name == "join":
            separator = argument if argument else ", "
            return separator.join(str(v) for v in value) if isinstance(value, list) else text
        if name == "default":
            return argument if not text.strip() else value
    except Exception as exc:  # noqa: BLE001 - one bad cell must not fail the job
        logger.debug("Transform %r failed: %s", transform, type(exc).__name__)
        return value

    logger.debug("Unknown transform %r ignored", name)
    return value


def coerce_type(value: Any, field_type: str, *, base_url: str = "") -> Any:
    """Convert to the declared type. Returns None when the value is unusable."""
    if value is None:
        return None

    if field_type == "list":
        if isinstance(value, list):
            return [v for v in (clean_text(str(v)) for v in value) if v]
        text = clean_text(str(value))
        return [text] if text else []

    if isinstance(value, list):
        # A single-value field that matched several nodes: take the first
        # non-empty value rather than a Python repr of the list.
        value = next((v for v in value if v not in (None, "")), None)
        if value is None:
            return None

    if field_type in {"text", "html"}:
        return clean_text(str(value)) if field_type == "text" else str(value)

    if field_type == "number":
        return parse_number(value)

    if field_type == "integer":
        parsed = parse_number(value)
        return int(parsed) if isinstance(parsed, (int, float)) else None

    if field_type == "bool":
        return parse_bool(value)

    if field_type == "date":
        return parse_date(value)

    if field_type in {"url", "image"}:
        text = clean_text(str(value))
        if not text:
            return None
        resolved = absolutize(text, base_url) if base_url else text
        if resolved:
            return resolved
        # Not URL-ish at all: return None rather than a base-joined garbage URL.
        return None

    if field_type == "json":
        import json

        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(str(value))
        except (json.JSONDecodeError, TypeError):
            return None

    return clean_text(str(value))


def infer_type(values: list[Any]) -> str:
    """Guess the narrowest type that fits every sample (used by auto-extract)."""
    samples = [v for v in values if v not in (None, "")]
    if not samples:
        return "text"

    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in samples):
        return "integer" if all(float(v).is_integer() for v in samples) else "number"

    texts = [clean_text(str(v)) for v in samples]
    if all(parse_number(t) is not None for t in texts) and any(any(c.isdigit() for c in t) for t in texts):
        return "number"
    if all(_URLISH_RE.match(t) for t in texts):
        return "image" if all(_IMAGE_EXT_RE.search(t) for t in texts) else "url"
    if all(parse_date(t) is not None for t in texts):
        return "date"
    return "text"


def resolve_relative(url_value: str, base_url: str) -> str:
    """Kept for callers that already know the value is a URL."""
    if not base_url:
        return url_value
    try:
        return urljoin(base_url, url_value)
    except Exception:
        return url_value
