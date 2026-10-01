"""AI endpoints: schema inference, natural-language config, record enrichment.

Every endpoint here is optional infrastructure. If no provider is configured the
endpoints still respond — with `configured: false` and a deterministic fallback
where one exists (schema inference falls back to structural detection). The UI
uses that flag to hide AI affordances rather than showing buttons that 503.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError

from ..config import settings
from ..core.text import truncate
from ..deps import AuthDep
from ..errors import AIUnavailable, EngineError
from ..extract.llm import heuristic_schema_hint, infer_schema
from ..fetch.http import http_fetcher
from ..llm.client import llm_client
from ..llm.prompts import (
    build_enrichment_prompt,
    build_nl_config_prompt,
    build_system_prompt,
    condense_html,
    new_fence_nonce,
)
from ..models import FetchSpec, InferSchemaRequest, RenderMode, ScrapeConfig
from ..parse.dom import parse_html

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/ai", tags=["ai"])


@router.get("/status", summary="Is an AI provider configured, and which model?")
async def ai_status(_: AuthDep) -> dict[str, Any]:
    return {
        "configured": llm_client.enabled,
        "model": settings.ai_model if llm_client.enabled else None,
        "baseUrl": settings.ai_base_url if llm_client.enabled else None,
        "maxOutputTokens": settings.ai_max_output_tokens,
        "features": {
            "schemaInference": llm_client.enabled,
            "naturalLanguageConfig": llm_client.enabled,
            "enrichment": llm_client.enabled,
            "heuristicAutoExtract": True,  # always available, no provider needed
        },
    }


@router.post("/infer-schema", summary="Infer a JSON Schema + selectors for a page")
async def post_infer_schema(_: AuthDep, request: InferSchemaRequest) -> dict[str, Any]:
    html = request.html
    base_url = request.url or "https://example.invalid/"

    if not html:
        if not request.url:
            raise HTTPException(status_code=422, detail="Provide html or url")
        try:
            fetched = await http_fetcher.fetch(
                request.url,
                FetchSpec(render=RenderMode.AUTO, save_html=True),
            )
        except EngineError as exc:
            raise HTTPException(status_code=502, detail=exc.message) from exc
        if fetched.status != "ok":
            raise HTTPException(status_code=502, detail=f"Could not fetch the page ({fetched.status})")
        html = fetched.body
        base_url = fetched.final_url

    dom = parse_html(html)

    # Structural inference needs no provider at all, so a missing AI key is a
    # degraded response, never an error: the UI always gets something it can
    # turn into a runnable config.
    if not llm_client.enabled:
        return {
            "configured": False,
            "reason": "No AI provider is configured; using structural detection.",
            "fallback": heuristic_schema_hint(dom),
        }

    try:
        inferred = await infer_schema(dom, base_url=base_url, instructions=request.instructions)
    except (AIUnavailable, EngineError) as exc:
        return {"configured": True, "error": exc.code, "reason": exc.message, "fallback": heuristic_schema_hint(dom)}

    return {"configured": True, **inferred}


class NaturalLanguageConfigRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=2000)
    url: str | None = None
    includePageContent: bool = True


@router.post("/config", summary="Turn a plain-English request into a validated ScrapeConfig")
async def post_natural_language_config(_: AuthDep, request: NaturalLanguageConfigRequest) -> dict[str, Any]:
    if not llm_client.enabled:
        raise HTTPException(
            status_code=503,
            detail="No AI provider is configured. Build the config manually, or set AI_BASE_URL and AI_API_KEY.",
        )

    page_content: str | None = None
    if request.includePageContent and request.url:
        try:
            fetched = await http_fetcher.fetch(request.url, FetchSpec(render=RenderMode.AUTO, save_html=True))
            if fetched.status == "ok":
                page_content = condense_html(fetched.body, max_chars=25_000)
        except EngineError:
            # Grounding is an enhancement; proceed without it.
            page_content = None

    nonce = new_fence_nonce()
    system = build_system_prompt(
        nonce,
        extra="You translate human intent into scraper configurations. Prefer `auto` extraction "
        "unless the request names specific fields, in which case propose concrete CSS selectors.",
    )
    user = build_nl_config_prompt(
        nonce=nonce,
        request_text=request.prompt,
        url=request.url,
        page_content=page_content,
    )

    try:
        payload, usage = await llm_client.complete_json(system=system, user=user, max_tokens=2000)
    except AIUnavailable as exc:
        raise HTTPException(status_code=503, detail=exc.message) from exc

    raw_config = payload.get("config") if isinstance(payload, dict) else None
    validated: ScrapeConfig | None = None
    validation_error: str | None = None

    if isinstance(raw_config, dict):
        if request.url and not raw_config.get("targets"):
            raw_config["targets"] = [request.url]
        try:
            validated = ScrapeConfig.model_validate(raw_config)
        except ValidationError as exc:
            # Hand the errors back rather than 422-ing: the UI can show the
            # user exactly which field the model got wrong and let them fix it.
            validation_error = truncate(str(exc.errors(include_url=False)[:5]), 800)

    return {
        "config": validated.model_dump(by_alias=True) if validated else None,
        "rawConfig": raw_config,
        "valid": validated is not None,
        "validationError": validation_error,
        "explanation": payload.get("explanation") if isinstance(payload, dict) else None,
        "usage": {"model": usage.model, "totalTokens": usage.total_tokens, "costUsd": usage.cost_usd},
    }


class EnrichRequest(BaseModel):
    records: list[dict[str, Any]] = Field(..., min_length=1, max_length=100)
    tasks: list[str] = Field(default_factory=lambda: ["summary", "entities"], max_length=6)
    labels: list[str] = Field(default_factory=list, max_length=50)
    instructions: str | None = Field(None, max_length=1000)
    model: str | None = None


@router.post("/enrich", summary="Summarise, classify and extract entities from records")
async def post_enrich(_: AuthDep, request: EnrichRequest) -> dict[str, Any]:
    if not llm_client.enabled:
        raise HTTPException(status_code=503, detail="No AI provider is configured.")

    nonce = new_fence_nonce()
    system_extra, user_prompt = build_enrichment_prompt(
        nonce=nonce,
        record=request.records[0],
        tasks=request.tasks,
        labels=request.labels,
        instructions=request.instructions,
    )
    system = build_system_prompt(nonce, extra=system_extra)

    results: list[dict[str, Any]] = []
    totals: dict[str, Any] = {"totalTokens": 0, "costUsd": 0.0, "calls": 0}

    for record in request.records[:100]:
        _, prompt = build_enrichment_prompt(
            nonce=nonce,
            record=record,
            tasks=request.tasks,
            labels=request.labels,
            instructions=request.instructions,
        )
        try:
            payload, usage = await llm_client.complete_json(
                system=system, user=prompt, model=request.model, max_tokens=1200
            )
        except EngineError as exc:
            results.append({"error": exc.code, "message": exc.message})
            continue

        totals["totalTokens"] += usage.total_tokens
        totals["costUsd"] = round(totals["costUsd"] + usage.cost_usd, 8)
        totals["calls"] += 1
        results.append(payload if isinstance(payload, dict) else {"value": payload})

    return {"results": results, "usage": totals}
