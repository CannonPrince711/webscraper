"""Application settings and process-wide logging.

Secrets are read from the environment only — never from files committed to the
repository. `log_redaction_filter` guarantees that a token, cookie or API key
can never be written to a log line or returned in an error payload.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
from functools import lru_cache
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}"),
    re.compile(r"(?i)\b(api[-_]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+"),
    re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),  # JWT
    re.compile(r"(?i)\b(cookie|set-cookie)\b\s*[:=]\s*\S+"),
    # Credentials embedded in a URL (`http://user:pass@proxy:7000`). Proxy
    # credentials live here, so a stray log line must not become a leak.
    re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@"),
)

_REDACTED = "[REDACTED]"


def redact(value: Any) -> Any:
    """Recursively scrub secret-looking substrings from a value."""
    if isinstance(value, str):
        out = value
        for pattern in _SECRET_PATTERNS:
            out = pattern.sub(_REDACTED, out)
        return out
    if isinstance(value, dict):
        return {
            k: (_REDACTED if k.lower() in _SENSITIVE_KEYS else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return type(value)(redact(v) for v in value)
    return value


_SENSITIVE_KEYS = frozenset(
    {
        "api_key", "apikey", "authorization", "cookie", "password", "secret",
        "set-cookie", "token", "access_token", "refresh_token", "proxy",
        "proxy_url", "private_key", "engine_api_key", "service_role_key",
        "decodo_username", "decodo_password",
    }
)


class _RedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        try:
            if isinstance(record.msg, str):
                record.msg = redact(record.msg)
            if record.args:
                record.args = redact(record.args)  # type: ignore[assignment]
        except Exception:  # never let logging take the process down
            pass
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line — parseable by any log drain."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("request_id", "url", "job_id", "run_id", "duration_ms",
                    "status_code", "bytes", "domain", "strategy", "error_code"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(redact(payload), default=str, ensure_ascii=False)


def configure_logging(level: str = "info", *, json_output: bool = True) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if json_output else logging.Formatter(
        "%(asctime)s %(levelname)-7s %(name)s :: %(message)s"
    ))
    handler.addFilter(_RedactionFilter())
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # These are noisy and can echo request URLs verbatim.
    for noisy in ("httpx", "httpcore", "urllib3", "asyncio", "trafilatura"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
class Settings(BaseSettings):
    """Runtime configuration. See the repo's `.env.example` for documentation."""

    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- app ---
    app_name: str = "webscraper-engine"
    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "info"
    log_json: bool = True

    # --- auth ---
    engine_api_key: str = "dev-engine-key-change-me"
    # When true, callers must also present a valid HMAC signature.
    engine_require_signature: bool = False
    signature_max_skew_seconds: int = 300

    # --- fetch defaults ---
    #
    # NOTE ON ENV NAMES: the tuning knobs below are documented and shipped (in
    # `.env.example` and docker-compose) with an `ENGINE_` prefix, while the
    # fields that both services share (`ENGINE_API_KEY`, `REDIS_URL`, `AI_*`,
    # `DECODO_*`) have no prefix. The `AliasChoices` aliases accept *both*
    # spellings — without them, `ENGINE_ENABLE_BROWSER=false` was accepted by
    # pydantic-settings and silently ignored, which is the worst possible
    # failure mode for a configuration knob.

    request_timeout_ms: int = Field(30_000, validation_alias=AliasChoices("ENGINE_REQUEST_TIMEOUT_MS", "REQUEST_TIMEOUT_MS"))
    connect_timeout_ms: int = Field(5_000, validation_alias=AliasChoices("ENGINE_CONNECT_TIMEOUT_MS", "CONNECT_TIMEOUT_MS"))
    max_response_bytes: int = 5_000_000
    max_decompression_ratio: int = 40
    max_redirects: int = 5
    user_agent: str = (
        "WebscraperBot/0.1 (+https://github.com/CannonPrince711/webscraper; "
        "contact: ops@example.com)"
    )
    default_headers: dict[str, str] = Field(default_factory=dict)

    # --- politeness ---
    respect_robots: bool = Field(True, validation_alias=AliasChoices("ENGINE_RESPECT_ROBOTS", "RESPECT_ROBOTS"))
    robots_cache_ttl_seconds: int = 3600
    robots_fail_open: bool = False  # unreachable robots.txt => allow (be a good citizen: False)
    rate_limit_per_domain_rps: float = 2.0
    rate_limit_burst: int = 5

    # --- SSRF ---
    allow_private_networks: bool = False  # self-hosted only; requires explicit opt-in
    pin_resolved_ip: bool = True
    allow_http_scheme: bool = True
    allowed_ports: Annotated[list[int], NoDecode] = Field(
        default_factory=lambda: [80, 443, 8080, 8443]
    )

    # --- browser ---
    enable_browser: bool = Field(True, validation_alias=AliasChoices("ENGINE_ENABLE_BROWSER", "ENABLE_BROWSER"))
    browser_pool_size: int = 3
    browser_nav_timeout_ms: int = 30_000
    browser_idle_timeout_ms: int = 120_000

    # --- concurrency ---
    max_concurrency: int = Field(8, validation_alias=AliasChoices("ENGINE_MAX_CONCURRENCY", "MAX_CONCURRENCY"))
    max_pages_per_request: int = 50

    # --- proxies ---
    # `NoDecode` is load-bearing: without it pydantic-settings JSON-decodes a
    # complex field *before* validators run, so the documented comma-separated
    # form ("http://a:3128,http://b:3128") raised a JSON parse error and an
    # empty value crashed startup. It now reaches the `_split_csv` validator.
    proxy_urls: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        validation_alias=AliasChoices("ENGINE_PROXY_URLS", "PROXY_URLS"),
    )
    # Managed residential proxies (Decodo, formerly Smartproxy). Credentials are
    # read here, never from a job config: a job only says `decodo://?country=us`,
    # so nothing secret is stored in the database or echoed back by the API.
    decodo_username: str | None = None
    decodo_password: str | None = None
    decodo_endpoint: str = "gate.decodo.com:7000"
    # Fallback country when a job does not name one. Blank = account default.
    decodo_country: str | None = None
    # Default sticky-session lifetime when a job asks for `sticky` without a
    # duration. Decodo allows up to 1440 minutes (24h).
    decodo_session_minutes: int = 10

    # --- redis (optional: distributed rate limits + robots cache) ---
    redis_url: str | None = None

    # --- AI ---
    ai_base_url: str | None = None
    ai_api_key: str | None = None
    ai_model: str = "gpt-4o-mini"
    ai_timeout_ms: int = 60_000
    ai_max_output_tokens: int = 4096
    ai_temperature: float = 0.0

    # --- CORS: the Next.js BFF calls server-side, so this stays empty by default ---
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # ------------------------------------------------------------------
    @field_validator("proxy_urls", "cors_origins", "allowed_ports", mode="before")
    @classmethod
    def _split_csv(cls, value: Any) -> Any:
        """Accept both the documented CSV form and a JSON array.

        `NoDecode` hands complex fields to this validator as raw strings, so the
        two spellings a human might reasonably write — `a,b` and `["a","b"]` —
        are both understood. An empty string is an empty list, not an error.
        """
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("[") and text.endswith("]"):
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            return [item.strip() for item in text.split(",") if item.strip()]
        return value

    @field_validator("ai_base_url")
    @classmethod
    def _strip_trailing_slash(cls, value: str | None) -> str | None:
        return value.rstrip("/") if value else value

    # ------------------------------------------------------------------
    @property
    def ai_enabled(self) -> bool:
        return bool(self.ai_base_url and self.ai_api_key)

    @property
    def browser_enabled(self) -> bool:
        return self.enable_browser

    @property
    def decodo_enabled(self) -> bool:
        return bool(self.decodo_username and self.decodo_password)

    def startup_warnings(self) -> list[str]:
        """Loud, non-fatal warnings for dangerous production configurations."""
        warnings: list[str] = []
        # A half-configured proxy is worse than none: jobs would fail at fetch
        # time with a 407 that looks like a bug in the scraper.
        if bool(self.decodo_username) != bool(self.decodo_password):
            warnings.append(
                "Decodo credentials are incomplete: set both DECODO_USERNAME and DECODO_PASSWORD "
                "(or neither). Jobs using the 'decodo' proxy policy will fail until this is fixed."
            )
        if self.environment == "production":
            if self.engine_api_key == "dev-engine-key-change-me":
                warnings.append(
                    "ENGINE_API_KEY is the default value in production — rotating it is mandatory."
                )
            if self.allow_private_networks:
                warnings.append(
                    "allow_private_networks=True in production: the SSRF guard is effectively off."
                )
            if not self.engine_require_signature:
                warnings.append(
                    "engine_require_signature=False: replay protection is disabled."
                )
        if not self.respect_robots:
            warnings.append("respect_robots=False: all crawl targets will be fetched regardless of robots.txt.")
        return warnings


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
