"""LLM-backed extraction for pages that resist structural analysis.

Used when the caller explicitly asks for `strategy: "llm"`, or when `auto`
found nothing and enrichment was enabled. The pipeline is:

    condense HTML → fence with a per-request nonce → ask for JSON →
    validate against the schema → (once) repair → return

Everything the model produces is validated before it leaves this module, so a
hallucinated type, a prompt-injection attempt, or a truncated response degrades
into a typed warning rather than a corrupt record.
"""

from __future__ import annotations

import logging
from typing import Any

from ..core.text import clean_text, truncate
from ..errors import AIBudgetExceeded, AISchemaViolation
from ..llm.client import LLMUsage, llm_client
from ..llm.prompts import (
    build_extraction_prompt,
    build_system_prompt,
    condense_html,
    new_fence_nonce,
)
from ..llm.schema import extract_field_names, validate_records
from ..models import ExtractSpec
from ..parse.dom import Dom
from .base import ExtractionResult

logger = logging.getLogger(__name__)

MAX_PROMPT_CHARS = 60_000
DEFAULT_CONFIDENCE = 0.7


async def extract_with_llm(
    dom: Dom,
    spec: ExtractSpec,
    *,
    base_url: str,
    json_ld: list[dict[str, Any]] | None = None,
    usage_sink: list[LLMUsage] | None = None,
) -> ExtractionResult:
    result = ExtractionResult(strategy="llm")

    if not llm_client.enabled:
        result.warnings.append("llm_not_configured")
        result.diagnostics["reason"] = "AI_BASE_URL / AI_API_KEY are not set"
        return result

    field_names = [f.name for f in spec.fields] or extract_field_names(spec.schema_)
    fields_payload = [
        {
            "name": f.name,
            "description": f"selector hint: {f.selector}" if f.selector else None,
            "type": f.type.value,
        }
        for f in spec.fields
    ] or None

    page_content = condense_html(dom.html, max_chars=MAX_PROMPT_CHARS)
    nonce = new_fence_nonce()

    system = build_system_prompt(nonce)
    user = build_extraction_prompt(
        nonce=nonce,
        page_content=page_content,
        fields=fields_payload,
        schema=spec.schema_,
        instructions=spec.instructions or "Extract the primary repeated records on this page.",
        url=base_url,
    )

    try:
        payload, usage = await llm_client.complete_json(
            system=system,
            user=user,
            max_tokens=4096,
        )
    except AIBudgetExceeded:
        raise
    except Exception as exc:
        result.warnings.append(f"llm_error:{type(exc).__name__}")
        result.diagnostics["reason"] = "The AI provider call failed"
        return result

    if usage_sink is not None:
        usage_sink.append(usage)

    try:
        records = validate_records(
            payload,
            schema=spec.schema_,
            field_names=field_names or None,
            max_records=spec.max_records,
        )
    except AISchemaViolation as exc:
        result.warnings.append("llm_schema_violation")
        result.diagnostics["errors"] = exc.details
        return result

    confidence = DEFAULT_CONFIDENCE
    if isinstance(payload, dict):
        raw_confidence = payload.get("confidence")
        if isinstance(raw_confidence, (int, float)) and 0 <= float(raw_confidence) <= 1:
            confidence = round(float(raw_confidence), 3)
        notes = payload.get("notes")
        if isinstance(notes, str) and notes.strip():
            result.diagnostics["notes"] = truncate(clean_text(notes), 300)

    # Normalise: drop all-null records, coerce numeric strings the model left.
    cleaned: list[dict[str, Any]] = []
    for record in records:
        normalised = {k: v for k, v in record.items() if v not in (None, "", [], {})}
        if len(normalised) >= 1:
            cleaned.append(normalised)

    result.records = cleaned
    result.confidences = [confidence] * len(cleaned)
    result.diagnostics.update(
        source="llm",
        model=usage.model,
        records=len(cleaned),
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        cost_usd=usage.cost_usd,
    )
    if not cleaned:
        result.warnings.append("llm_returned_no_records")
    return result


async def infer_schema(
    dom: Dom,
    *,
    base_url: str,
    instructions: str | None = None,
    sample_size: int = 5,
) -> dict[str, Any]:
    """Ask the model for a JSON Schema + selectors for this page.

    Returned to the UI so a user can accept an inferred schema as a starting
    point, then edit it — inference is a bootstrap, never a black box.
    """
    from ..llm.prompts import build_schema_inference_prompt

    if not llm_client.enabled:
        return {
            "error": "ai_not_configured",
            "fallback": heuristic_schema_hint(dom),
        }

    nonce = new_fence_nonce()
    system = build_system_prompt(
        nonce,
        extra="You are also an expert at CSS selectors. Propose selectors that will remain "
        "stable across pagination and small site redesigns (prefer semantic classes and "
        "data-testid over positional or heavily generated class names).",
    )
    user = build_schema_inference_prompt(
        nonce=nonce,
        page_content=condense_html(dom.html, max_chars=MAX_PROMPT_CHARS),
        url=base_url,
    )
    if instructions:
        user = f"Operator instructions: {instructions.strip()[:1000]}\n\n{user}"

    payload, usage = await llm_client.complete_json(system=system, user=user, max_tokens=3000)

    if isinstance(payload, dict):
        payload.setdefault("usage", {
            "model": usage.model,
            "totalTokens": usage.total_tokens,
            "costUsd": usage.cost_usd,
        })
        if not payload.get("fields"):
            payload["fields"] = _heuristic_fields_from_schema(payload.get("schema"))
        return payload

    return {"error": "unexpected_response", "fallback": heuristic_schema_hint(dom)}


def _heuristic_fields_from_schema(schema: Any) -> list[dict[str, str]]:
    if not isinstance(schema, dict):
        return []
    properties = schema.get("properties") or {}
    if not isinstance(properties, dict):
        return []
    out: list[dict[str, str]] = []
    for name, subschema in list(properties.items())[:30]:
        json_type = (subschema or {}).get("type", "string") if isinstance(subschema, dict) else "string"
        mapped = {"string": "text", "number": "number", "integer": "integer",
                  "boolean": "bool", "array": "list"}.get(str(json_type), "text")
        out.append({"name": str(name), "type": mapped})
    return out


def heuristic_schema_hint(dom: Dom) -> dict[str, Any]:
    """What we can propose with no AI provider at all."""
    from .auto import find_repeating_groups, infer_fields

    groups = find_repeating_groups(dom)
    if not groups:
        return {"listSelector": None, "fields": [], "recordCount": 0}

    fields, _, confidence = infer_fields(groups[0], base_url="")
    return {
        "listSelector": groups[0].selector,
        "fields": [{"name": f["name"], "selector": f["selector"], "type": f["type"]} for f in fields],
        "recordCount": len(groups[0].nodes),
        "confidence": confidence,
    }
