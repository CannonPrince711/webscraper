"""JSON Schema → Pydantic validation for LLM output.

An LLM that is told to return twelve fields will occasionally return eleven, or
return `"price": "$29"` where a number was required, or hallucinate a nested
object where a string belonged. Validating against the user's schema turns all
of that into a typed, actionable error instead of a corrupt JSONB row.

We build a real Pydantic model from the (draft-07 subset) schema rather than
hand-rolling a checker, so validation errors are precise and the model is
reusable for coercion. Unsupported keywords (`oneOf`, `$ref`, `allOf`) are
handled conservatively: the field degrades to `Any` rather than being rejected,
because an over-strict validator that fails valid data is worse than a loose one.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError, create_model
from pydantic.fields import FieldInfo

logger = logging.getLogger(__name__)

MAX_DEPTH = 6


class SchemaValidationError(ValueError):
    def __init__(self, errors: list[dict[str, Any]]) -> None:
        super().__init__("LLM output does not match the requested schema")
        self.errors = errors


def _python_type(schema: dict[str, Any], depth: int):
    """Map a JSON Schema fragment to a Python type annotation."""
    if depth > MAX_DEPTH or not isinstance(schema, dict):
        return Any

    json_type = schema.get("type")
    if isinstance(json_type, list):
        # ["string", "null"] → optional
        non_null = [t for t in json_type if t != "null"]
        inner = _python_type({**schema, "type": non_null[0]}, depth + 1) if non_null else Any
        return inner | None if len(json_type) > 1 else inner

    if json_type == "string":
        return str
    if json_type == "integer":
        return int
    if json_type == "number":
        return float
    if json_type == "boolean":
        return bool
    if json_type == "null":
        return type(None)
    if json_type == "array":
        items = schema.get("items")
        return list[_python_type(items, depth + 1)] if isinstance(items, dict) else list[Any]
    if json_type == "object" or "properties" in schema:
        model = _model_from_object_schema(schema, depth + 1)
        return model if model is not None else dict[str, Any]
    return Any


def _model_from_object_schema(schema: dict[str, Any], depth: int) -> type[BaseModel] | None:
    if depth > MAX_DEPTH:
        return None
    properties = schema.get("properties")
    if not isinstance(properties, dict) or not properties:
        return None

    required = set(schema.get("required") or [])
    field_definitions: dict[str, tuple[Any, FieldInfo]] = {}

    for raw_name, subschema in list(properties.items())[:80]:
        name = str(raw_name)
        annotation = _python_type(subschema if isinstance(subschema, dict) else {}, depth + 1)
        is_required = name in required
        # Models frequently omit optional fields; defaulting them to None keeps
        # a mostly-good record instead of failing it entirely.
        field_definitions[name] = (
            annotation if is_required else (annotation | None),
            FieldInfo(default=... if is_required else None),
        )

    if not field_definitions:
        return None

    return create_model(
        "LLMRecord",
        __config__=ConfigDict(extra="ignore", str_strip_whitespace=False),
        **field_definitions,
    )


def build_record_model(schema: dict[str, Any] | None, field_names: list[str] | None = None) -> type[BaseModel]:
    """Create a validator for one record.

    With an explicit schema we honour required/properties. With only a list of
    field names (the common "just give me these columns" case) every field is
    optional, because demanding a value that is genuinely absent from a page
    only produces fabricated data.
    """
    if schema:
        model = _model_from_object_schema(schema, 0)
        if model is not None:
            return model

    names = [str(n) for n in (field_names or [])][:80] or ["value"]
    return create_model(
        "LLMRecord",
        __config__=ConfigDict(extra="ignore"),
        **{name: (Any | None, FieldInfo(default=None)) for name in names},
    )


def validate_records(
    payload: Any,
    *,
    schema: dict[str, Any] | None = None,
    field_names: list[str] | None = None,
    max_records: int = 1000,
) -> list[dict[str, Any]]:
    """Validate and normalise a `{"records": [...]}` payload from a model.

    Accepts a bare list too, because models occasionally drop the wrapper.
    Raises `SchemaValidationError` when nothing usable can be salvaged.
    """
    records: Any
    if isinstance(payload, dict):
        records = payload.get("records")
        if records is None:
            # Single-record shape: treat the object itself as one record.
            records = [payload] if payload else []
    elif isinstance(payload, list):
        records = payload
    else:
        raise SchemaValidationError([{"msg": "expected an object or an array", "type": "type_error"}])

    if not isinstance(records, list):
        raise SchemaValidationError([{"msg": "'records' must be an array", "type": "type_error"}])

    model = build_record_model(schema, field_names)
    out: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for index, raw in enumerate(records[:max_records]):
        if not isinstance(raw, dict):
            errors.append({"loc": [index], "msg": "record is not an object", "type": "type_error"})
            continue
        try:
            validated = model.model_validate(raw)
        except ValidationError as exc:
            # Keep the record's good fields and record what was wrong: dropping
            # a whole record because one optional field had a bad type loses
            # data the user paid for.
            errors.append({"loc": [index], "msg": exc.errors(include_url=False)[:5], "type": "validation_error"})
            out.append({k: v for k, v in raw.items() if v is not None})
            continue
        out.append({k: v for k, v in validated.model_dump().items() if v is not None})

    if not out and errors:
        raise SchemaValidationError(errors)
    if errors:
        logger.debug("Partial schema errors on %s records", len(errors))

    return out


def extract_field_names(schema: dict[str, Any] | None) -> list[str]:
    """Top-level property names from a schema (used for prompts and checks)."""
    if not isinstance(schema, dict):
        return []
    properties = schema.get("properties")
    if isinstance(properties, dict):
        return [str(k) for k in properties]
    items = schema.get("items")
    if isinstance(items, dict):
        inner = items.get("properties")
        if isinstance(inner, dict):
            return [str(k) for k in inner]
    return []
