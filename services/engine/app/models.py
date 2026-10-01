"""The `ScrapeConfig` contract and everything that crosses the wire.

This module is the Python half of a contract that also exists in TypeScript
(``packages/shared/src/scrape-config.ts``). Both sides validate the same
document, so a UI bug that produces an invalid config fails at the API boundary
with a precise message instead of silently mis-scraping.

Validators here are security-relevant as well as correctness-relevant: user
supplied headers are checked for CRLF injection and hop-by-hop headers, field
names are constrained so they can never become a prototype-pollution key in the
Node consumer, and every limit is clamped to a hard ceiling that the caller
cannot raise.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

MAX_TARGETS = 500
MAX_FIELDS = 200
MAX_HEADER_COUNT = 30
MAX_HEADER_VALUE_LENGTH = 2048

# Headers a client may never set: they either break the transport or let a
# caller smuggle a second request into the first.
FORBIDDEN_REQUEST_HEADERS: frozenset[str] = frozenset(
    {
        "host", "content-length", "content-type", "connection", "keep-alive",
        "proxy-authorization", "proxy-connection", "transfer-encoding",
        "upgrade", "te", "trailer", "expect",
    }
)

_FIELD_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$")


class ContractModel(BaseModel):
    """Base for everything crossing the wire between Node and Python.

    The JSON contract is **camelCase** — it is authored in TypeScript in
    `packages/shared` and consumed by the UI, so `listSelector` must work. Python
    code prefers `list_selector`. An alias generator gives us both: either
    spelling is accepted on input, and `model_dump(by_alias=True)` emits the
    canonical camelCase that the worker and UI expect.

    Accepting both is deliberate — it costs nothing and removes an entire class
    of "worked in the test, broke in the app" serialisation bugs.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class JobMode(str, Enum):
    SINGLE = "single"
    CRAWL = "crawl"
    SITEMAP = "sitemap"
    BATCH = "batch"


class RenderMode(str, Enum):
    AUTO = "auto"      # try HTTP, escalate to the browser when the shell looks empty
    HTTP = "http"      # never launch a browser
    JS = "js"          # always render


class ExtractStrategy(str, Enum):
    AUTO = "auto"        # heuristics + JSON-LD + meta, no LLM required
    SELECTORS = "selectors"
    LLM = "llm"
    RECIPE = "recipe"


class FieldType(str, Enum):
    TEXT = "text"
    HTML = "html"
    NUMBER = "number"
    INTEGER = "integer"
    BOOL = "bool"
    DATE = "date"
    URL = "url"
    IMAGE = "image"
    LIST = "list"
    JSON = "json"


class DeviceProfile(str, Enum):
    DESKTOP = "desktop"
    MOBILE = "mobile"
    TABLET = "tablet"


# ---------------------------------------------------------------------------
# Config pieces
# ---------------------------------------------------------------------------
class ExtractField(ContractModel):
    """One output column: where to read it, and how to clean it up."""

    name: str = Field(..., description="snake_case output key")
    selector: str | None = Field(None, max_length=1000)
    selector_type: Literal["css", "xpath"] = "css"
    # Read from an attribute instead of the text node (href, src, data-price…).
    attribute: str | None = Field(None, max_length=100)
    type: FieldType = FieldType.TEXT
    # Applied left to right. Parameterised forms: `regex:<pat>`, `replace:<a>:<b>`,
    # `join:<sep>`, `prefix:<s>`, `suffix:<s>`, `default:<v>`.
    transforms: list[str] = Field(default_factory=list, max_length=20)
    required: bool = False
    default: Any = None
    constant: Any = None
    # Return every match as a list rather than the first.
    all: bool = False

    # Fallback selectors tried in order when the primary yields nothing —
    # the cheapest possible robustness against a site redesign.
    fallback_selectors: list[str] = Field(default_factory=list, max_length=10)

    # Read straight out of the page's JSON-LD / embedded JSON blob by path,
    # e.g. "offers.price" or "aggregateRating.ratingValue".
    json_path: str | None = Field(None, max_length=300)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, value: str) -> str:
        normalized = value.strip().lower().replace(" ", "_").replace("-", "_")
        if not _FIELD_NAME_RE.match(normalized):
            raise ValueError(
                "field name must start with a letter and contain only a-z, 0-9 and _ (max 64 chars)"
            )
        # Reserved: these would shadow Object.prototype members downstream.
        if normalized in {"__proto__", "constructor", "prototype", "tostring", "valueof"}:
            raise ValueError(f"field name '{normalized}' is reserved")
        return normalized

    @field_validator("attribute")
    @classmethod
    def _valid_attribute(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        if cleaned in {"onload", "onerror", "onclick"} or cleaned.startswith("on"):
            raise ValueError("event-handler attributes are not extractable")
        return cleaned

    @model_validator(mode="after")
    def _needs_a_source(self) -> ExtractField:
        if self.constant is not None:
            return self
        if not any([self.selector, self.json_path, self.fallback_selectors]):
            raise ValueError(f"field '{self.name}' needs a selector, a json_path or a constant")
        return self


class ExtractSpec(ContractModel):
    # `schema` is a Python builtin-adjacent word; the alias stays explicit.
    strategy: ExtractStrategy = ExtractStrategy.AUTO
    # Scopes the record boundary: each match becomes one record.
    list_selector: str | None = Field(None, max_length=1000)
    fields: list[ExtractField] = Field(default_factory=list, max_length=MAX_FIELDS)
    # JSON Schema constraining LLM output (strategy=llm).
    schema_: dict[str, Any] | None = Field(None, alias="schema")
    # Keep only the first N records per page.
    max_records: int = Field(1000, ge=1, le=10_000)
    # Collapse duplicates within the job using these fields.
    dedupe_by: list[str] = Field(default_factory=list, max_length=10)
    # Minimum confidence (0-1) for auto-extraction to be considered successful.
    min_confidence: float = Field(0.35, ge=0.0, le=1.0)
    # Instructions for LLM extraction, e.g. "extract the author and publish date".
    instructions: str | None = Field(None, max_length=2000)


class CrawlSpec(ContractModel):
    max_depth: int = Field(2, ge=0, le=6)
    max_pages: int = Field(100, ge=1, le=5000)
    same_domain: bool = True
    # Glob patterns against the URL path.
    include: list[str] = Field(default_factory=list, max_length=50)
    exclude: list[str] = Field(default_factory=list, max_length=50)
    # Prefer sitemap.xml over link discovery when available.
    use_sitemap: bool = True
    # Follow link rel=nofollow?
    follow_nofollow: bool = False
    # Extra delay between requests to the same domain, on top of the rps limit.
    delay_ms: int = Field(0, ge=0, le=60_000)
    concurrency: int = Field(4, ge=1, le=16)
    # Revisit URLs already known from a previous run (needed for monitors).
    revisit: bool = False


class FetchSpec(ContractModel):
    render: RenderMode = RenderMode.AUTO
    # CSS selector to wait for, or a number of milliseconds as a string ("1500").
    wait_for: str | None = Field(None, max_length=200)
    timeout_ms: int = Field(30_000, ge=1000, le=180_000)
    respect_robots: bool = True
    # Caps enforced server-side regardless of what the caller asks for.
    max_bytes: int = Field(5_000_000, ge=1024, le=25_000_000)
    headers: dict[str, str] = Field(default_factory=dict)
    # Custom UA is allowed but a "pretend to be a human" default is not applied;
    # callers who spoof take responsibility for that choice.
    user_agent: str | None = Field(None, max_length=400)
    proxy: str | None = Field(None, max_length=500)
    device: DeviceProfile = DeviceProfile.DESKTOP
    viewport_width: int = Field(1440, ge=320, le=3840)
    viewport_height: int = Field(900, ge=240, le=2160)
    screenshot: bool = False
    save_html: bool = True
    block_assets: bool = True
    # Follow redirects at all? Redirect hops are always re-validated.
    follow_redirects: bool = True
    max_redirects: int = Field(5, ge=0, le=10)
    # Send Referer on in-page navigations inside the browser.
    referer: str | None = Field(None, max_length=2000)

    @field_validator("headers")
    @classmethod
    def _safe_headers(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > MAX_HEADER_COUNT:
            raise ValueError(f"at most {MAX_HEADER_COUNT} custom headers are allowed")
        cleaned: dict[str, str] = {}
        for key, raw in value.items():
            name = str(key).strip()
            if not _HEADER_NAME_RE.match(name):
                raise ValueError(f"invalid header name: {name!r}")
            if name.lower() in FORBIDDEN_REQUEST_HEADERS:
                raise ValueError(f"header '{name}' cannot be overridden")
            body = str(raw)
            # CRLF injection would let a caller append arbitrary requests or
            # response-splitting payloads to our outbound connection.
            if any(ch in body for ch in ("\r", "\n", "\x00")):
                raise ValueError(f"header '{name}' contains illegal control characters")
            if len(body) > MAX_HEADER_VALUE_LENGTH:
                raise ValueError(f"header '{name}' is too long")
            cleaned[name] = body
        return cleaned


class AiSpec(ContractModel):
    # "summary", "entities", "classify", "embed", "custom"
    enrich: list[str] = Field(default_factory=list, max_length=10)
    model: str | None = Field(None, max_length=100)
    temperature: float | None = Field(None, ge=0.0, le=1.0)
    # Categories for classify.
    labels: list[str] = Field(default_factory=list, max_length=50)
    instructions: str | None = Field(None, max_length=2000)
    max_tokens: int | None = Field(None, ge=64, le=8192)


class LimitsSpec(ContractModel):
    max_pages: int = Field(5000, ge=1, le=20_000)
    max_bytes_per_page: int = Field(5_000_000, ge=1024, le=25_000_000)
    max_duration_ms: int = Field(3_600_000, ge=10_000, le=86_400_000)
    max_ai_tokens: int = Field(120_000, ge=0, le=2_000_000)


class ScrapeConfig(ContractModel):
    """The one document that describes a scrape, from any entry point."""

    version: Literal[1] = 1
    targets: list[str] = Field(..., min_length=1, max_length=MAX_TARGETS)
    mode: JobMode = JobMode.SINGLE
    crawl: CrawlSpec = Field(default_factory=CrawlSpec)
    fetch: FetchSpec = Field(default_factory=FetchSpec)
    extract: ExtractSpec = Field(default_factory=ExtractSpec)
    ai: AiSpec = Field(default_factory=AiSpec)
    limits: LimitsSpec = Field(default_factory=LimitsSpec)
    meta: dict[str, Any] = Field(default_factory=dict)

    @field_validator("targets")
    @classmethod
    def _clean_targets(cls, value: list[str]) -> list[str]:
        out: list[str] = []
        for raw in value:
            target = str(raw).strip()
            if not target:
                continue
            if len(target) > 4096:
                raise ValueError("target URL is too long")
            if target not in out:
                out.append(target)
        if not out:
            raise ValueError("at least one non-empty target is required")
        return out

    @model_validator(mode="after")
    def _validate_combination(self) -> ScrapeConfig:
        if self.mode in {JobMode.CRAWL, JobMode.SITEMAP} and self.crawl.max_pages < 1:
            raise ValueError("crawl mode requires crawl.max_pages >= 1")
        # `selectors` mode without fields would silently return nothing, which
        # reads as "the site changed" rather than "the config is wrong".
        if self.extract.strategy == ExtractStrategy.SELECTORS and not self.extract.fields:
            raise ValueError("strategy 'selectors' requires at least one field")
        # A list_selector scopes records; without it a multi-field scrape
        # produces exactly one record from the document root, which is legal but
        # almost always a mistake in crawl mode.
        if (
            self.mode in {JobMode.CRAWL, JobMode.SITEMAP}
            and self.extract.list_selector is None
            and self.extract.strategy == ExtractStrategy.SELECTORS
        ):
            raise ValueError("crawl mode with explicit selectors requires extract.list_selector")
        return self


# ---------------------------------------------------------------------------
# Runtime results
# ---------------------------------------------------------------------------
class FetchResult(BaseModel):
    """Raw output of the fetch layer, before any parsing."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    url: str
    final_url: str
    status: str = "ok"                 # ok | not_modified | http_error | blocked | timeout | error
    http_status: int | None = None
    content_type: str | None = None
    body: str = ""
    body_bytes: int = 0
    duration_ms: int = 0
    fetch_method: Literal["http", "browser"] = "http"
    headers: dict[str, str] = Field(default_factory=dict)
    redirect_chain: list[str] = Field(default_factory=list)
    screenshot_png: bytes | None = None
    rendered: bool = False
    error_code: str | None = None
    error_message: str | None = None


class ExtractedRecord(BaseModel):
    data: dict[str, Any]
    confidence: float = 1.0
    source_index: int = 0


class PageResult(ContractModel):
    """Everything the worker needs to persist one page."""

    url: str
    final_url: str
    status: str
    http_status: int | None = None
    content_type: str | None = None
    title: str | None = None
    lang: str | None = None
    canonical_url: str | None = None
    content_hash: str | None = None
    body_bytes: int = 0
    duration_ms: int = 0
    fetch_method: str = "http"
    rendered: bool = False
    depth: int = 0
    # Extracted data — the payload the user actually wants.
    records: list[dict[str, Any]] = Field(default_factory=list)
    record_confidences: list[float] = Field(default_factory=list)
    # Derived text representations.
    markdown: str | None = None
    text: str | None = None
    html: str | None = None
    # Page-level facts: title, description, og:*, twitter:*, author, published.
    metadata: dict[str, Any] = Field(default_factory=dict)
    json_ld: list[dict[str, Any]] = Field(default_factory=list)
    headings: list[dict[str, str]] = Field(default_factory=list)
    # Link graph — the input to crawl frontier expansion.
    links: list[dict[str, Any]] = Field(default_factory=list)
    sitemaps: list[str] = Field(default_factory=list)
    screenshot_png_b64: str | None = None
    # How the records were produced (strategy, selector counts, timings) so the
    # UI can explain *why* a field came out empty.
    extraction: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None


# ---------------------------------------------------------------------------
# API envelopes
# ---------------------------------------------------------------------------
class ScrapeRequest(ContractModel):
    config: ScrapeConfig
    # Overrides config.targets when provided (used by crawl link discovery).
    urls: list[str] | None = Field(None, max_length=MAX_TARGETS)
    # Depth of these URLs in the crawl, echoed back on each page.
    depth: int = Field(0, ge=0, le=10)
    include_html: bool = False
    request_id: str | None = Field(None, max_length=64)
    # Wall-clock ceiling for the whole batch.
    deadline_ms: int | None = Field(None, ge=100, le=600_000)


class ScrapeStats(ContractModel):
    pages_total: int = 0
    pages_ok: int = 0
    pages_failed: int = 0
    bytes_total: int = 0
    records_total: int = 0
    duration_ms: int = 0
    browser_renders: int = 0


class ScrapeResponse(ContractModel):
    results: list[PageResult]
    stats: ScrapeStats
    discovered: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class SelectorProbe(ContractModel):
    """A single selector/field test, for the visual picker in the UI."""

    name: str
    selector: str
    selector_type: Literal["css", "xpath"] = "css"
    attribute: str | None = None
    matches: int = 0
    samples: list[str] = Field(default_factory=list)
    error: str | None = None


class ExtractRequest(ContractModel):
    # Either supply HTML directly (fast, no network) or a URL to fetch first.
    html: str | None = Field(None, max_length=10_000_000)
    url: str | None = None
    config: ScrapeConfig

    @model_validator(mode="after")
    def _one_source(self) -> ExtractRequest:
        if not self.html and not self.url:
            raise ValueError("provide either html or url")
        return self


class InferSchemaRequest(ContractModel):
    url: str | None = None
    html: str | None = Field(None, max_length=10_000_000)
    instructions: str | None = Field(None, max_length=2000)
    sample_size: int = Field(5, ge=1, le=25)


class ProxyCheckRequest(ContractModel):
    """Which proxy policy to test. Empty = the server's configured default."""

    policy: str | None = Field(None, max_length=500)


class ProxyCheckResponse(ContractModel):
    """Result of routing one request through the proxy.

    Reports the *label* of the policy, never the resolved URL: the URL contains
    the provider password, and this response is rendered in a browser.
    """

    ok: bool
    kind: str
    label: str
    configured: bool
    duration_ms: float
    endpoint: str | None = None
    exit_ip: str | None = None
    country: str | None = None
    city: str | None = None
    isp: str | None = None
    error: str | None = None
    hint: str | None = None


class HealthResponse(ContractModel):
    status: Literal["ok", "degraded"]
    version: str
    browser_available: bool
    ai_enabled: bool
    redis_available: bool
    uptime_seconds: float
    checks: dict[str, Any] = Field(default_factory=dict)
