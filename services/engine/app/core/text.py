"""Value coercion, sanitisation and export safety.

Extraction is only useful if a price scraped as "  $1.299,00 " becomes the
number 1299.0 that a spreadsheet can sum, and if a product name beginning with
"=cmd" cannot execute when the CSV is opened. Both live here.
"""

from __future__ import annotations

import html
import re
import unicodedata
from datetime import date, datetime
from typing import Any
from urllib.parse import urljoin

_WHITESPACE = re.compile(r"[ \t\u00a0\u200b]+")
_MULTI_NEWLINE = re.compile(r"\n{3,}")
_TAGS = re.compile(r"<[^>]+>")
_HTML_DROP = re.compile(r"(?is)<(script|style|noscript|template|svg)[^>]*>.*?</\1>")
_NUMBER_CLEAN = re.compile(r"[^\d.,\-+]")
_CURRENCY = re.compile(r"[^\d.,\-+]")

# Locale-aware number parsing is genuinely ambiguous: 1.299 in German is 1299,
# in English it is 1.299. We resolve it structurally (see parse_number).
_CURRENCY_SYMBOLS = "$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u20ba\u20a6\u20b1\u00a2\u5143\uffe5"


def clean_text(value: str | None, *, collapse_newlines: bool = True) -> str:
    """Normalise whitespace and strip invisible characters."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    text = text.replace("\u200b", "").replace("\ufeff", "")
    text = _WHITESPACE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    if collapse_newlines:
        text = _MULTI_NEWLINE.sub("\n\n", text)
    return text.strip()


def strip_html(value: str | None) -> str:
    """Remove tags and unescape entities. Not a sanitiser — a text extractor."""
    if not value:
        return ""
    return clean_text(html.unescape(_TAGS.sub(" ", _HTML_DROP.sub(" ", value))))


def parse_number(value: Any) -> float | int | None:
    """Parse a human-formatted number.

    Handles ``$1,299.00``, ``1.299,00 €``, ``1 299,00``, ``12%``, ``(42)``
    (accounting negative) and ``1.2K``/``3.4M`` shorthand.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value

    text = clean_text(str(value))
    if not text:
        return None

    negative = text.startswith("(") and text.endswith(")")  # accounting notation
    text = text.strip("()")

    multiplier = 1.0
    suffix = text[-1:].upper()
    if suffix in {"K", "M", "B", "T"}:
        multiplier = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000, "T": 1_000_000_000_000}[suffix]
        text = text[:-1]

    cleaned = _NUMBER_CLEAN.sub("", _CURRENCY.sub("", text))
    if not cleaned or cleaned in {"-", "+", ".", ","}:
        return None

    has_comma, has_dot = "," in cleaned, "." in cleaned
    if has_comma and has_dot:
        # Whichever separator appears last is the decimal separator.
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif has_comma:
        parts = cleaned.split(",")
        # "1,299" is a thousands group; "10,5" is a European decimal.
        cleaned = cleaned.replace(",", ".") if len(parts[-1]) in {1, 2} and len(parts) == 2 else cleaned.replace(",", "")
    elif has_dot:
        parts = cleaned.split(".")
        if len(parts) > 2 or (len(parts) == 2 and len(parts[-1]) == 3 and len(parts[0]) <= 3 and len(parts[0]) > 0):
            # 1.299.000 or 1.299 => thousands separators
            if len(parts) > 2 or (len(parts[0]) <= 3 and not parts[0].startswith("0") and len(parts[0]) > 0 and len(parts[-1]) == 3):
                cleaned = cleaned.replace(".", "")

    try:
        number = float(cleaned) * multiplier
    except ValueError:
        return None

    if negative:
        number = -number
    return int(number) if number.is_integer() and multiplier == 1 else number


def parse_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = clean_text(str(value)).lower()
    if text in {"true", "yes", "y", "1", "on", "in stock", "available", "ja"}:
        return True
    if text in {"false", "no", "n", "0", "off", "out of stock", "sold out", "nein"}:
        return False
    return None


def parse_date(value: Any, *, iso: bool = True) -> str | None:
    """Parse a date string into ISO-8601. Returns None when unparseable."""
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    text = clean_text(str(value))
    if not text:
        return None
    try:
        from dateutil import parser as date_parser

        parsed = date_parser.parse(text, fuzzy=True, dayfirst=False)
        return parsed.date().isoformat() if iso else parsed.isoformat()
    except Exception:
        return None


def absolutize(value: str | None, base_url: str) -> str | None:
    """Resolve a relative URL against the page it came from."""
    if not value:
        return None
    text = clean_text(value)
    if not text:
        return None
    if text.startswith(("data:", "javascript:", "mailto:", "tel:")):
        return None
    try:
        return urljoin(base_url, text)
    except Exception:
        return None


def csv_safe(value: Any) -> str:
    """Neutralise spreadsheet formula injection.

    A cell beginning with ``=``, ``+``, ``-``, ``@``, TAB or CR is executed as a
    formula by Excel/Sheets. Since the cell content came from an untrusted web
    page, it is prefixed with an apostrophe. Quoting alone does *not* fix this.
    """
    if value is None:
        return ""
    text = str(value)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


def truncate(value: str | None, limit: int = 500, suffix: str = "…") -> str:
    if not value:
        return ""
    text = str(value)
    return text if len(text) <= limit else text[: max(0, limit - len(suffix))] + suffix


def snake_case(value: str) -> str:
    text = re.sub(r"[^\w\s-]", "", unicodedata.normalize("NFKD", value)).strip().lower()
    return re.sub(r"[-\s]+", "_", text)[:64] or "field"


def dedupe_preserving_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def estimate_tokens(text: str) -> int:
    """Cheap token estimate (~4 chars/token) for budget enforcement.

    Deliberately an over-estimate: blowing a budget is worse than refusing a
    request that would have fit.
    """
    return max(1, len(text) // 3)
