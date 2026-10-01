"""Extraction strategies.

`selectors` — exact, deterministic, cheap; what a saved recipe uses.
`auto`      — structural heuristics + structured data; no config, no LLM cost.
`llm`       — schema-guided inference for genuinely ambiguous pages.

All three return the same `ExtractionResult`, so the pipeline and the UI do not
need to know which one ran.
"""

from .base import ExtractionResult, extract_records  # noqa: F401
