"""A minimal OpenAI-compatible chat client.

Deliberately not the OpenAI SDK. Every serious provider — OpenAI, Azure,
Groq, Together, OpenRouter, Fireworks, vLLM, Ollama, LM Studio, llama.cpp —
exposes `/v1/chat/completions`, and a 120-line httpx client that speaks that
protocol keeps the deployment story simple: change `AI_BASE_URL`, no code
change, no vendor lock-in, no transitive dependency on a library that moves
faster than the API it wraps.

What this client does that a naive one does not:

* **Retries** 429/5xx with jittered backoff, and honours `Retry-After`.
* **Degrades on `response_format`** — JSON mode is not universal; a 400 that
  mentions it triggers one retry without it rather than a hard failure.
* **Strips fences** — models still wrap JSON in ```json blocks.
* **Accounts for cost** — every call returns token usage and an estimated USD
  cost from a pricing table, which the worker aggregates against the org's
  monthly ceiling.
* **Never logs the key or the raw prompt** — prompts can contain scraped
  personal data, which must not land in a log drain.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..config import settings
from ..core.text import estimate_tokens
from ..errors import AIUnavailable

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^\s*```(?:json|JSON)?\s*|\s*```\s*$")

# USD per 1M tokens (input, output). Approximate list prices; used for budget
# accounting, not billing. Unknown models are costed as the default model.
_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-nano": (0.10, 0.40),
    "o4-mini": (1.10, 4.40),
    "claude-3-5-haiku": (0.80, 4.00),
    "claude-3-5-sonnet": (3.00, 15.00),
    "claude-sonnet-4": (3.00, 15.00),
    "llama-3.3-70b-versatile": (0.59, 0.79),
    "llama-3.1-8b-instant": (0.05, 0.08),
    "mixtral-8x7b-32768": (0.24, 0.24),
    "gemini-2.0-flash": (0.10, 0.40),
    "deepseek-chat": (0.27, 1.10),
    "qwen2.5-72b-instruct": (0.35, 0.40),
}
_DEFAULT_PRICE = (0.15, 0.60)


@dataclass
class LLMUsage:
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    calls: int = 0
    cached: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def merge(self, other: LLMUsage) -> LLMUsage:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.total_tokens += other.total_tokens
        self.cost_usd += other.cost_usd
        self.calls += other.calls
        return self


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    key = (model or "").lower()
    price_in, price_out = _PRICING.get(key, _DEFAULT_PRICE)
    for known, rates in _PRICING.items():
        if known in key:
            price_in, price_out = rates
            break
    return round(
        (prompt_tokens / 1_000_000) * price_in + (completion_tokens / 1_000_000) * price_out,
        8,
    )


class LLMClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()
        self._json_mode_supported = True

    @property
    def enabled(self) -> bool:
        return settings.ai_enabled

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is not None and not self._client.is_closed:
            return self._client
        async with self._lock:
            if self._client is not None and not self._client.is_closed:
                return self._client
            self._client = httpx.AsyncClient(
                base_url=settings.ai_base_url or "https://api.openai.com/v1",
                headers={
                    "Authorization": f"Bearer {settings.ai_api_key or ''}",
                    "Content-Type": "application/json",
                    "User-Agent": "webscraper-engine/0.1",
                },
                timeout=httpx.Timeout(
                    connect=10.0,
                    read=settings.ai_timeout_ms / 1000,
                    write=30.0,
                    pool=10.0,
                ),
                limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
                trust_env=False,
            )
            return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------
    async def complete(
        self,
        *,
        system: str,
        user: str,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        json_mode: bool = True,
        max_attempts: int = 3,
    ) -> tuple[str, LLMUsage]:
        if not self.enabled:
            raise AIUnavailable(
                "No AI provider is configured",
                details={"hint": "set AI_BASE_URL and AI_API_KEY, or disable AI features"},
            )

        effective_model = model or settings.ai_model
        payload: dict[str, Any] = {
            "model": effective_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": settings.ai_temperature if temperature is None else temperature,
            "max_tokens": max_tokens or settings.ai_max_output_tokens,
        }
        if json_mode and self._json_mode_supported:
            payload["response_format"] = {"type": "json_object"}

        client = await self._get_client()
        usage = LLMUsage(model=effective_model)
        prompt_tokens_estimate = estimate_tokens(system) + estimate_tokens(user)

        attempt = 0
        while True:
            attempt += 1
            started = time.perf_counter()
            try:
                response = await client.post("/chat/completions", json=payload)
            except httpx.TimeoutException as exc:
                raise AIUnavailable("The AI provider did not respond in time") from exc
            except httpx.HTTPError as exc:
                raise AIUnavailable(
                    "Could not reach the AI provider",
                    details={"reason": type(exc).__name__},
                ) from exc

            if response.status_code == 400 and "response_format" in payload:
                # Provider does not implement JSON mode; drop it and retry once.
                logger.info("Provider rejected response_format; retrying without it")
                payload.pop("response_format", None)
                self._json_mode_supported = False
                continue

            if response.status_code == 429 or response.status_code >= 500:
                if attempt >= max_attempts:
                    raise AIUnavailable(
                        f"AI provider returned HTTP {response.status_code} after {attempt} attempts",
                        details={"status": response.status_code},
                    )
                retry_after = response.headers.get("retry-after") or ""
                wait = min(float(retry_after), 15.0) if retry_after.isdigit() else min(1.5 * 2 ** attempt, 12.0)
                await asyncio.sleep(wait * (0.6 + random.random() * 0.6))
                continue

            if response.status_code >= 400:
                # Never echo the provider's body: it can contain the prompt back.
                raise AIUnavailable(
                    f"AI provider rejected the request (HTTP {response.status_code})",
                    details={"status": response.status_code},
                )

            try:
                body = response.json()
            except ValueError as exc:
                raise AIUnavailable("AI provider returned a non-JSON response") from exc

            choices = body.get("choices") or []
            content = (choices[0].get("message", {}) or {}).get("content") if choices else None
            if not content:
                raise AIUnavailable("AI provider returned an empty completion")

            raw_usage = body.get("usage") or {}
            usage.prompt_tokens = int(raw_usage.get("prompt_tokens") or prompt_tokens_estimate)
            usage.completion_tokens = int(raw_usage.get("completion_tokens") or estimate_tokens(str(content)))
            usage.total_tokens = int(raw_usage.get("total_tokens") or (usage.prompt_tokens + usage.completion_tokens))
            usage.cost_usd = estimate_cost(effective_model, usage.prompt_tokens, usage.completion_tokens)
            usage.calls += 1
            usage.extra["duration_ms"] = int((time.perf_counter() - started) * 1000)
            return content, usage

    # ------------------------------------------------------------------
    async def complete_json(self, **kwargs: Any) -> tuple[Any, LLMUsage]:
        """As `complete`, but parses (and, once, repairs) the JSON payload."""
        content, usage = await self.complete(json_mode=True, **kwargs)
        parsed = _parse_json_lenient(content)
        if parsed is not None:
            return parsed, usage

        # One repair attempt: ask the model to fix its own output rather than
        # failing the whole page.
        logger.info("Repairing malformed JSON from the model")
        repair_system = (
            "You convert malformed JSON into valid JSON. Output ONLY the corrected JSON "
            "document with no explanation, no markdown fences and no trailing text."
        )
        repaired, repair_usage = await self.complete(
            system=repair_system,
            user=_FENCE_RE.sub("", content)[:20_000],
            model=kwargs.get("model"),
            max_tokens=kwargs.get("max_tokens"),
            temperature=0.0,
            json_mode=True,
            max_attempts=2,
        )
        usage.merge(repair_usage)
        parsed = _parse_json_lenient(repaired)
        if parsed is None:
            from ..errors import AISchemaViolation

            raise AISchemaViolation("The model did not return valid JSON", details={"retryable": True})
        return parsed, usage


def _parse_json_lenient(content: str) -> Any | None:
    """Parse JSON that may be fenced, prefixed, or have trailing prose."""
    if not content:
        return None
    text = content.strip()
    text = _FENCE_RE.sub("", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Take the outermost object/array.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    return None


llm_client = LLMClient()
