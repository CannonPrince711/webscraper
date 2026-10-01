"""Deterministic selector extraction — the backbone of every saved recipe.

Contract: given the same HTML and the same config, this produces byte-identical
records. That reproducibility is what makes change detection, dedupe and
diffing trustworthy; it is also why the LLM strategy is never used to *fill in*
gaps in a selector run.

Field resolution order per record:
  constant → JSON-LD path → primary selector → fallback selectors → default
Each step is recorded in `diagnostics`, so the UI can tell a user exactly which
selector matched nothing instead of showing a blank cell.
"""

from __future__ import annotations

import logging
from typing import Any

from ..core.text import absolutize, clean_text, truncate
from ..models import ExtractField, ExtractSpec
from ..parse.dom import Dom, DomNode
from ..parse.metadata import flatten_json_ld, json_ld_search, json_path_get
from .base import ExtractionResult
from .transforms import apply_transforms, coerce_type

logger = logging.getLogger(__name__)

# Attributes that mean "the text", rather than a real HTML attribute.
_TEXT_PSEUDO_ATTRS = {"text", "innertext", "content_text"}
_HTML_PSEUDO_ATTRS = {"html", "innerhtml"}
_URL_ATTRS = {"href", "src", "srcset", "data-src", "data-url", "content", "action", "poster"}


def _select(scope: DomNode, dom: Dom, selector: str, selector_type: str, limit: int) -> tuple[list[DomNode], str]:
    """Run a selector inside a record scope.

    Returns the nodes plus the scope actually used, so a document-scoped XPath
    fallback can be reported honestly instead of silently changing semantics.
    """
    if selector_type == "xpath":
        if scope._kind == "xpath":  # type: ignore[attr-defined]
            return scope.xpath(selector, limit), "record"
        # An XPath cannot be evaluated relative to a selectolax node, so it runs
        # document-wide. Legal, but it means the field is not per-record scoped.
        return dom.xpath(selector, limit), "document"
    return scope.css(selector, limit), "record"


def _node_value(node: DomNode, field: ExtractField, base_url: str) -> Any:
    attribute = (field.attribute or "").lower()

    if not attribute or attribute in _TEXT_PSEUDO_ATTRS:
        return node.text()

    if attribute in _HTML_PSEUDO_ATTRS:
        return node.inner_html()

    raw = node.attr(attribute)
    if raw is None:
        return None

    if attribute in _URL_ATTRS:
        if attribute == "srcset":
            raw = raw.split(",")[0].strip().split(" ")[0]
        return absolutize(raw, base_url) or raw
    return clean_text(raw)


def _resolve_field(
    scope: DomNode,
    dom: Dom,
    field: ExtractField,
    base_url: str,
    json_ld: list[dict[str, Any]],
    diagnostics: dict[str, Any],
) -> Any:
    info: dict[str, Any] = {"matched": False, "selector_used": None, "matches": 0}

    # 1. Constant
    if field.constant is not None:
        info.update(matched=True, selector_used="constant")
        diagnostics[field.name] = info
        return field.constant

    # 2. Structured data — exact, so it wins over any selector ambiguity.
    if field.json_path and json_ld:
        value = json_ld_search(json_ld, field.json_path)
        if value is None:
            # Also allow a path relative to the scope's own JSON-LD-ish content.
            value = json_path_get(json_ld[0] if json_ld else {}, field.json_path)
        if value is not None:
            info.update(matched=True, selector_used=f"json_ld:{field.json_path}")
            diagnostics[field.name] = info
            return coerce_type(value, field.type.value, base_url=base_url)

    # 3. Scope/JSON-LD hybrid: a selector plus a nested json path in the node.
    #    (Handled implicitly: `attribute='json'` reads a JSON blob out of an attr.)

    # 4. Selectors, primary then fallbacks.
    candidates = [s for s in [field.selector, *field.fallback_selectors] if s]
    limit = 200 if field.all else 5

    for selector in candidates:
        nodes, scope_used = _select(scope, dom, selector, field.selector_type, limit)
        if not nodes:
            continue

        if "json" in (field.attribute or "").lower() and field.selector:
            # `attribute="json"` decodes a JSON payload embedded in an element.
            import json

            try:
                payload = json.loads(nodes[0].text() or nodes[0].inner_html())
            except (json.JSONDecodeError, TypeError):
                continue
            path = field.attribute.split(":", 1)[1] if ":" in field.attribute else None
            value = json_path_get(payload, path) if path else payload
            if value is not None:
                info.update(matched=True, selector_used=f"{selector}[json]", matches=len(nodes), scope=scope_used)
                diagnostics[field.name] = info
                return coerce_type(value, field.type.value, base_url=base_url)

        if field.all:
            values = [_node_value(node, field, base_url) for node in nodes]
            values = [v for v in values if v not in (None, "")]
            if values:
                value = apply_transforms(values, field.transforms, base_url=base_url)
                info.update(matched=True, selector_used=selector, matches=len(nodes), scope=scope_used)
                diagnostics[field.name] = info
                return coerce_type(value, "list", base_url=base_url)
            continue

        raw = _node_value(nodes[0], field, base_url)
        if raw is None or raw == "":
            info["matches"] = len(nodes)
            continue

        value = apply_transforms(raw, field.transforms, base_url=base_url)
        if value is None or value == "":
            info["matches"] = len(nodes)
            continue

        info.update(matched=True, selector_used=selector, matches=len(nodes), scope=scope_used)
        diagnostics[field.name] = info
        return coerce_type(value, field.type.value, base_url=base_url)

    # 5. Default
    if field.default is not None:
        info.update(matched=True, selector_used="default")
        diagnostics[field.name] = info
        return coerce_type(field.default, field.type.value, base_url=base_url)

    diagnostics[field.name] = info
    return None


def extract_with_selectors(
    dom: Dom,
    spec: ExtractSpec,
    *,
    base_url: str,
    json_ld: list[dict[str, Any]] | None = None,
) -> ExtractionResult:
    result = ExtractionResult(strategy="selectors")
    blocks = flatten_json_ld(json_ld or [])

    if not spec.fields:
        result.warnings.append("no_fields_configured")
        result.diagnostics["reason"] = "extract.fields is empty"
        return result

    # --- pick record scopes -------------------------------------------
    if spec.list_selector:
        if spec.list_selector.strip().lower().startswith(("/", "(")) or spec.list_selector.strip().startswith("//"):
            scopes = dom.xpath(spec.list_selector, limit=spec.max_records)
        else:
            scopes = dom.css(spec.list_selector, limit=spec.max_records)
        if not scopes:
            result.warnings.append(f"list_selector_matched_nothing:{spec.list_selector}")
            result.diagnostics["list_selector"] = spec.list_selector
            result.diagnostics["list_matches"] = 0
            return result
        result.diagnostics["list_selector"] = spec.list_selector
        result.diagnostics["list_matches"] = len(scopes)
    else:
        scopes = [dom.root]
        result.diagnostics["list_selector"] = None
        result.diagnostics["list_matches"] = 1

    # --- extract ------------------------------------------------------
    records: list[dict[str, Any]] = []
    confidences: list[float] = []
    field_diagnostics: dict[str, Any] = {}
    total_fields = max(len(spec.fields), 1)

    for index, scope in enumerate(scopes[: spec.max_records]):
        per_record: dict[str, Any] = {}
        matched = 0
        required_missing: list[str] = []

        for field in spec.fields:
            value = _resolve_field(scope, dom, field, base_url, blocks, field_diagnostics)
            per_record[field.name] = value
            if value not in (None, "", []):
                matched += 1
            elif field.required:
                required_missing.append(field.name)

        # A record that matched nothing at all is a false-positive scope (a
        # wrapper div that happens to share a class), not an empty record.
        if matched == 0:
            continue

        confidence = matched / total_fields
        if required_missing:
            confidence *= 0.5
            if len(result.warnings) < 20:
                result.warnings.append(f"record_{index}_missing_required:{','.join(required_missing)}")

        records.append(per_record)
        confidences.append(round(confidence, 3))

    # --- dedupe -------------------------------------------------------
    if spec.dedupe_by:
        records, confidences = _dedupe(records, confidences, spec.dedupe_by)

    result.records = records
    result.confidences = confidences
    result.diagnostics["fields"] = field_diagnostics
    result.diagnostics["records"] = len(records)

    if not records:
        result.warnings.append("no_records_extracted")
    return result


def _dedupe(
    records: list[dict[str, Any]],
    confidences: list[float],
    keys: list[str],
) -> tuple[list[dict[str, Any]], list[float]]:
    """Collapse duplicates by key set, keeping the highest-confidence record."""
    best: dict[tuple, tuple[dict[str, Any], float]] = {}
    order: list[tuple] = []

    for record, confidence in zip(records, confidences, strict=False):
        signature = tuple(clean_text(str(record.get(key) or "")).lower() for key in keys)
        if all(not part for part in signature):
            signature = ("__empty__", id(record))
        existing = best.get(signature)
        if existing is None:
            best[signature] = (record, confidence)
            order.append(signature)
        elif confidence > existing[1]:
            best[signature] = (record, confidence)

    return [best[sig][0] for sig in order], [best[sig][1] for sig in order]


def suggest_selectors(dom: Dom, sample: dict[str, Any], base_url: str = "") -> dict[str, Any]:
    """Given a record produced by another strategy, propose CSS selectors.

    Used by the visual picker: the user points at data, we return a config they
    can save as a deterministic recipe instead of paying for an LLM on every run.
    """
    suggested: list[dict[str, Any]] = []
    for name, value in (sample or {}).items():
        if value in (None, ""):
            continue
        text = truncate(clean_text(str(value)), 80)
        if not text:
            continue

        found: str | None = None
        for selector in ("h1", "h2", "h3", "a", "span", "p", "div", "li", "td", "time"):
            for node in dom.css(selector, limit=200):
                if clean_text(node.text()) == text:
                    found = selector
                    break
            if found:
                break
        if found:
            suggested.append({"name": name, "selector": found, "type": "text"})

    return {"fields": suggested}
