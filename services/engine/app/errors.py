"""Typed, validated errors.

Every failure mode the engine can produce has a stable machine-readable code.
The worker maps these onto user-facing messages, so an end user never sees a
raw Python traceback or an internal hostname.
"""

from __future__ import annotations

from typing import Any


class EngineError(Exception):
    """Base class for all engine failures."""

    code: str = "engine_error"
    http_status: int = 500
    retryable: bool = False

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "retryable": self.retryable,
                "details": self.details,
            }
        }


# --- security ---------------------------------------------------------------
class SSRFBlocked(EngineError):
    code = "ssrf_blocked"
    http_status = 400
    retryable = False


class RobotsDisallowed(EngineError):
    code = "robots_disallowed"
    http_status = 403
    retryable = False


class Unauthorized(EngineError):
    code = "unauthorized"
    http_status = 401
    retryable = False


class RateLimited(EngineError):
    code = "rate_limited"
    http_status = 429
    retryable = True


# --- network ----------------------------------------------------------------
class FetchFailed(EngineError):
    code = "fetch_failed"
    http_status = 502
    retryable = True


class FetchTimeout(EngineError):
    code = "fetch_timeout"
    http_status = 504
    retryable = True


class ResponseTooLarge(EngineError):
    code = "response_too_large"
    http_status = 413
    retryable = False


class UnsupportedContentType(EngineError):
    code = "unsupported_content_type"
    http_status = 415
    retryable = False


class BrowserUnavailable(EngineError):
    code = "browser_unavailable"
    http_status = 503
    retryable = True


class ProxyMisconfigured(EngineError):
    """The job asked for a proxy the engine cannot build (usually a missing key)."""

    code = "proxy_misconfigured"
    http_status = 400
    retryable = False


# --- extraction -------------------------------------------------------------
class InvalidConfig(EngineError):
    code = "invalid_config"
    http_status = 422
    retryable = False


class ExtractionFailed(EngineError):
    code = "extraction_failed"
    http_status = 422
    retryable = False


# --- AI ---------------------------------------------------------------------
class AIUnavailable(EngineError):
    code = "ai_unavailable"
    http_status = 503
    retryable = True


class AIBudgetExceeded(EngineError):
    code = "ai_budget_exceeded"
    http_status = 402
    retryable = False


class AISchemaViolation(EngineError):
    code = "ai_schema_violation"
    http_status = 422
    retryable = True
