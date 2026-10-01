"""Strategy dispatch and the shared extraction result.

The pipeline calls `extract_records`; the strategy decides how. Keeping the
dispatch here (rather than in the router) means every entry point — API, worker,
tests — exercises the same code path and the same fallbacks.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..models import ExtractSpec, ExtractStrategy, ScrapeConfig
from ..parse.dom import Dom

logger = logging.getLogger(__name__)


@dataclass
class ExtractionResult:
    records: list[dict[str, Any]] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    strategy: str = "auto"
    warnings: list[str] = field(default_factory=list)
    # What the strategy actually did — surfaced in the UI so an empty result is
    # explainable rather than mysterious.
    diagnostics: dict[str, Any] = field(default_factory=dict)
    # A ready-to-save selector config derived from a successful auto run.
    suggested_config: dict[str, Any] | None = None


async def extract_records(
    dom: Dom,
    config: ScrapeConfig,
    *,
    base_url: str,
    json_ld: list[dict[str, Any]] | None = None,
    allow_llm: bool = True,
) -> ExtractionResult:
    """Run the configured strategy, with graceful degradation."""
    spec: ExtractSpec = config.extract
    strategy = spec.strategy

    if strategy == ExtractStrategy.SELECTORS:
        from .selectors import extract_with_selectors

        return extract_with_selectors(dom, spec, base_url=base_url, json_ld=json_ld)

    if strategy == ExtractStrategy.RECIPE:
        # A recipe is a stored selector config; identical execution, but a
        # different provenance in diagnostics.
        from .selectors import extract_with_selectors

        result = extract_with_selectors(dom, spec, base_url=base_url, json_ld=json_ld)
        result.strategy = "recipe"
        return result

    if strategy == ExtractStrategy.LLM:
        if not allow_llm:
            result = ExtractionResult(strategy="llm", warnings=["llm_disabled"])
            result.diagnostics["reason"] = "LLM extraction was requested but no provider is configured"
            return result
        from .llm import extract_with_llm

        return await extract_with_llm(dom, spec, base_url=base_url, json_ld=json_ld)

    # --- auto: structured data first, then structure, then LLM if allowed ---
    from .auto import extract_auto

    result = extract_auto(dom, spec, base_url=base_url, json_ld=json_ld)

    if not result.records and allow_llm and config.ai.enrich:
        # Auto found nothing and the user asked for AI work: let the model try
        # once rather than returning an empty page.
        try:
            from .llm import extract_with_llm

            llm_result = await extract_with_llm(dom, spec, base_url=base_url, json_ld=json_ld)
            if llm_result.records:
                llm_result.warnings = result.warnings + ["escalated_to_llm"] + llm_result.warnings
                return llm_result
        except Exception as exc:  # noqa: BLE001 - must not fail the page
            result.warnings.append(f"llm_escalation_failed:{type(exc).__name__}")

    return result
