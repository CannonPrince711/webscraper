"""Request authentication: bearer key + optional HMAC body signature.

Two independent factors:

1. ``Authorization: Bearer <ENGINE_API_KEY>`` — proves the caller knows the
   shared secret. Compared with `hmac.compare_digest` so a timing oracle
   cannot recover the key byte by byte.
2. ``X-Webscraper-Signature: t=<unix>,v1=<hex>`` — HMAC-SHA256 over
   ``f"{t}.".encode() + raw_body``. Because the timestamp is inside the signed
   payload and outside a bounded skew window, a captured request cannot be
   replayed and a mutated body is rejected.
"""

from __future__ import annotations

import hashlib
import hmac
import time

from ..config import settings
from ..errors import Unauthorized

SIGNATURE_HEADER = "X-Webscraper-Signature"
_TIMESTAMP_HEADER = "X-Webscraper-Timestamp"


def _constant_time_eq(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def verify_api_key(authorization: str | None, *, expected: str | None = None) -> None:
    """Validate the bearer token. Raises `Unauthorized` on any mismatch."""
    secret = expected or settings.engine_api_key
    if not authorization:
        raise Unauthorized("Missing Authorization header", details={"reason": "missing_header"})

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized("Expected 'Authorization: Bearer <key>'", details={"reason": "bad_scheme"})

    if not _constant_time_eq(token.strip(), secret):
        # Deliberately vague: never confirm whether the key existed but was wrong.
        raise Unauthorized("Invalid credentials", details={"reason": "bad_key"})


def build_signature(body: bytes, timestamp: int | None = None, *, secret: str | None = None) -> str:
    """Produce the header value a caller must send. Used by clients and tests."""
    ts = timestamp if timestamp is not None else int(time.time())
    key = (secret or settings.engine_api_key).encode("utf-8")
    mac = hmac.new(key, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def verify_signature(
    header: str | None,
    body: bytes,
    *,
    secret: str | None = None,
    max_skew: int | None = None,
) -> None:
    """Validate the HMAC header. Raises `Unauthorized` when it does not hold."""
    if not header:
        raise Unauthorized("Missing signature header", details={"reason": "missing_signature"})

    parts: dict[str, str] = {}
    for chunk in header.split(","):
        key, _, value = chunk.strip().partition("=")
        if key:
            parts[key] = value

    ts_raw = parts.get("t")
    digest = parts.get("v1")
    if not ts_raw or not digest:
        raise Unauthorized("Malformed signature header", details={"reason": "malformed_signature"})

    try:
        ts = int(ts_raw)
    except ValueError as exc:
        raise Unauthorized("Malformed signature timestamp", details={"reason": "bad_timestamp"}) from exc

    skew = max_skew if max_skew is not None else settings.signature_max_skew_seconds
    if abs(int(time.time()) - ts) > skew:
        raise Unauthorized(
            "Signature timestamp outside the accepted window",
            details={"reason": "stale_signature", "max_skew_seconds": skew},
        )

    key = (secret or settings.engine_api_key).encode("utf-8")
    expected = hmac.new(key, f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, digest):
        raise Unauthorized("Signature does not match the request body", details={"reason": "bad_signature"})


def sign_webhook_payload(body: bytes, secret: str, timestamp: int | None = None) -> str:
    """Same scheme, used for outbound webhooks (mirrors the Node implementation)."""
    return build_signature(body, timestamp, secret=secret)


def hash_api_key(raw_key: str, *, pepper: str | None = None) -> str:
    """SHA-256 of an API key. Only the hash is ever stored."""
    material = f"{pepper}{raw_key}".encode() if pepper else raw_key.encode("utf-8")
    return hashlib.sha256(material).hexdigest()
