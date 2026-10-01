"""Structural auto-extraction — find the records without being told where.

Most valuable pages on the web are *lists of similar things*: product grids,
search results, job boards, news indexes, directory listings. That similarity is
a structural signal, and this module exploits it in three passes, cheapest first:

1. **Structured data** — JSON-LD (`Product`, `ItemList`, `Article`, `JobPosting`,
   `Event`, `Recipe`…). Exact, published by the site, and free. Always wins.
2. **Meta/OpenGraph** — a single "record" describing the page. The right answer
   for article pages with no JSON-LD.
3. **Repeated-structure detection** — group sibling elements by a structural
   signature (tag + stable classes), score the groups by content density and
   field diversity, then infer a selector and a type per field.

The successful output of pass 3 is a *selector config*, which the UI offers to
save as a recipe. That is the point of the whole design: pay for inference once,
then run deterministically forever.

Deliberate non-goal: no LLM call here. `strategy="llm"` exists for genuinely
ambiguous pages, and `auto` escalates to it only when it finds nothing at all
and the caller opted in.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from collections.abc import Iterable
from typing import Any

from ..core.text import clean_text, parse_date, parse_number, truncate
from ..models import ExtractSpec
from ..parse.dom import Dom, DomNode
from ..parse.metadata import extract_json_ld, flatten_json_ld, json_path_get
from .base import ExtractionResult
from .transforms import infer_type

logger = logging.getLogger(__name__)

MIN_RECORDS = 3
MAX_CANDIDATE_NODES = 6000
MAX_RECORD_NODES = 400
MAX_FIELDS = 15
FIELD_COVERAGE_THRESHOLD = 0.6

# Containers that are structural noise rather than data.
_BOILERPLATE_TAGS = {"nav", "header", "footer", "aside", "form", "script", "style", "template"}
_BOILERPLATE_HINTS = re.compile(
    r"(nav|menu|footer|header|sidebar|breadcrumb|cookie|consent|banner|advert|\bads?\b|"
    r"social|share|pagination|pager|carousel|slider|toolbar|skip|modal|drawer)",
    re.IGNORECASE,
)

# Class/id tokens that suggest what a field is, used to name inferred fields.
_FIELD_NAME_HINTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"price|cost|amount|\bprijs\b|precio", re.I), "price"),
    (re.compile(r"title|headline|name|heading", re.I), "title"),
    (re.compile(r"desc|summary|excerpt|snippet|teaser|blurb", re.I), "description"),
    (re.compile(r"date|time|when|published|updated", re.I), "date"),
    (re.compile(r"author|byline|writer|creator|vendor|seller|brand", re.I), "author"),
    (re.compile(r"image|photo|thumb|picture|media|avatar|logo", re.I), "image"),
    (re.compile(r"url|link|href|permalink", re.I), "url"),
    (re.compile(r"rating|score|stars|review", re.I), "rating"),
    (re.compile(r"categor|tag|type|kind|genre|section", re.I), "category"),
    (re.compile(r"location|city|address|region|country|place", re.I), "location"),
    (re.compile(r"sku|isbn|upc|ean|code|id\b", re.I), "sku"),
    (re.compile(r"stock|availability|status", re.I), "availability"),
)

# JSON-LD @type → {our field: dotted path inside that node}
_JSON_LD_MAPS: dict[str, dict[str, str]] = {
    "product": {
        "title": "name", "description": "description", "image": "image",
        "url": "url", "sku": "sku", "brand": "brand.name", "price": "offers.price",
        "currency": "offers.priceCurrency", "availability": "offers.availability",
        "rating": "aggregateRating.ratingValue", "review_count": "aggregateRating.reviewCount",
        "condition": "itemCondition", "category": "category",
    },
    "offer": {
        "title": "name", "price": "price", "currency": "priceCurrency",
        "availability": "availability", "url": "url", "valid_from": "validFrom",
    },
    "article": {
        "title": "headline", "description": "description", "author": "author.name",
        "published_at": "datePublished", "modified_at": "dateModified",
        "image": "image", "url": "url", "section": "articleSection", "word_count": "wordCount",
    },
    "newsarticle": {
        "title": "headline", "description": "description", "author": "author.name",
        "published_at": "datePublished", "modified_at": "dateModified", "image": "image", "url": "url",
    },
    "blogposting": {
        "title": "headline", "description": "description", "author": "author.name",
        "published_at": "datePublished", "image": "image", "url": "url",
    },
    "jobposting": {
        "title": "title", "description": "description", "published_at": "datePosted",
        "valid_through": "validThrough", "company": "hiringOrganization.name",
        "location": "jobLocation.address.addressLocality", "employment_type": "employmentType",
        "salary": "baseSalary.value.value", "salary_currency": "baseSalary.currency",
        "remote": "jobLocationType",
    },
    "event": {
        "title": "name", "description": "description", "start_date": "startDate",
        "end_date": "endDate", "location": "location.name", "url": "url",
        "price": "offers.price", "currency": "offers.priceCurrency", "status": "eventStatus",
    },
    "recipe": {
        "title": "name", "description": "description", "image": "image", "author": "author.name",
        "published_at": "datePublished", "prep_time": "prepTime", "cook_time": "cookTime",
        "yield": "recipeYield", "cuisine": "recipeCuisine", "rating": "aggregateRating.ratingValue",
    },
    "organization": {
        "title": "name", "description": "description", "url": "url", "logo": "logo",
        "phone": "telephone", "email": "email", "address": "address.streetAddress",
    },
    "person": {"title": "name", "url": "url", "description": "description", "job_title": "jobTitle"},
    "localbusiness": {
        "title": "name", "description": "description", "address": "address.streetAddress",
        "city": "address.addressLocality", "phone": "telephone", "price_range": "priceRange",
        "rating": "aggregateRating.ratingValue", "url": "url",
    },
    "faqpage": {"title": "name"},
    "breadcrumblist": {"title": "name", "url": "item"},
}

_LIST_TYPES = {"itemlist", "breadcrumblist", "faqpage"}
_ALIASES = {
    "article": "article", "newsarticle": "newsarticle", "blogposting": "blogposting",
    "techarticle": "article", "scholarlyarticle": "article",
    "localbusiness": "localbusiness", "restaurant": "localbusiness", "store": "localbusiness",
    "person": "person", "organization": "organization", "webpage": "organization",
    "web site": "organization", "website": "organization",
}


# ---------------------------------------------------------------------------
# Pass 1 — structured data
# ---------------------------------------------------------------------------
def records_from_json_ld(blocks: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes = flatten_json_ld(blocks)
    if not nodes:
        return []

    # ItemList with elements: the canonical multi-record structured-data shape.
    for node in nodes:
        node_type = _types_of(node)
        if "itemlist" in node_type:
            elements = node.get("itemListElement")
            if isinstance(elements, list) and elements:
                records = _records_from_item_list(elements)
                if len(records) >= 2:
                    return records

    # Otherwise map the richest single node we recognise.
    best: list[dict[str, Any]] = []
    for node in nodes:
        types = _types_of(node)
        for type_name in types:
            key = _ALIASES.get(type_name, type_name)
            mapping = _JSON_LD_MAPS.get(key)
            if not mapping:
                continue
            record = _apply_mapping(node, mapping)
            if len(record) >= 2 and len(record) > len(best or [{}]) - 1:
                if len(record) > (len(best[0]) if best else 0):
                    best = [record]
            break
    return best


def _types_of(node: dict[str, Any]) -> set[str]:
    raw = node.get("@type") or node.get("type")
    if isinstance(raw, str):
        return {raw.lower()}
    if isinstance(raw, list):
        return {str(t).lower() for t in raw}
    return set()


def _apply_mapping(node: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    record: dict[str, Any] = {}
    for field, path in mapping.items():
        value = json_path_get(node, path)
        if value is None:
            continue
        if isinstance(value, dict):
            value = value.get("name") or value.get("@id") or value.get("url")
        if isinstance(value, list):
            value = next((v for v in value if v not in (None, "")), None)
        if value is None:
            continue
        if isinstance(value, str):
            text = clean_text(value)
            if not text:
                continue
            if field in {"price", "rating", "review_count", "word_count", "salary"}:
                numeric = parse_number(text)
                value = numeric if numeric is not None else text
            elif field.endswith("_at") or field.endswith("_date") or field == "date":
                value = parse_date(text) or text
            else:
                value = truncate(text, 2000)
        record[field] = value
    return record


def _records_from_item_list(elements: list[Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        item = element.get("item") if isinstance(element.get("item"), dict) else element
        record: dict[str, Any] = {}
        for source, target in (("name", "title"), ("url", "url"), ("description", "description"),
                               ("@id", "id"), ("image", "image")):
            value = item.get(source)
            if isinstance(value, dict):
                value = value.get("name") or value.get("url")
            if isinstance(value, list):
                value = value[0] if value else None
            if isinstance(value, str) and value.strip():
                record[target] = truncate(clean_text(value), 1000)
        if "url" not in record and isinstance(element.get("url"), str):
            record["url"] = element["url"]
        if len(record) >= 2:
            records.append(record)
    return records


# ---------------------------------------------------------------------------
# Pass 2 — meta / OpenGraph
# ---------------------------------------------------------------------------
def record_from_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    record = {
        key: metadata.get(key)
        for key in ("title", "description", "author", "published_at", "modified_at",
                    "site_name", "canonical_url", "locale", "price", "currency")
        if metadata.get(key)
    }
    if metadata.get("images"):
        record["image"] = metadata["images"][0]
    if metadata.get("keywords"):
        record["keywords"] = ", ".join(metadata["keywords"][:10])
    return record


# ---------------------------------------------------------------------------
# Pass 3 — repeated structure detection
# ---------------------------------------------------------------------------
def _node_signature(node: DomNode, *, include_parent: bool = True) -> str:
    """Structural fingerprint: tag + sorted classes, optionally parent-scoped.

    Scoping by parent stops a site's navigation `<li>`s from being merged with
    the content `<li>`s into one bogus group.
    """
    classes = node.attr("class") or ""
    tokens = sorted({c for c in classes.split() if c and len(c) < 40})
    own = f"{node.tag}#{'.'.join(tokens)}"
    if not include_parent:
        return own
    parent = node.raw.parent if hasattr(node.raw, "parent") else None
    if parent is None:
        return "root>" + own
    parent_classes = ""
    try:
        parent_classes = parent.attributes.get("class") or ""
    except Exception:
        parent_classes = ""
    parent_sig = f"{getattr(parent, 'tag', '?')}#{'.'.join(sorted({c for c in parent_classes.split() if c and len(c) < 40}))}"
    return f"{parent_sig}>{own}"


def _has_boilerplate_ancestor(node: DomNode, *, max_depth: int = 4) -> bool:
    current = node.raw
    for _ in range(max_depth):
        if current is None:
            return False
        tag = getattr(current, "tag", "") or ""
        if str(tag).lower() in _BOILERPLATE_TAGS:
            return True
        try:
            attrs = current.attributes if hasattr(current, "attributes") else getattr(current, "attrib", {})
        except Exception:
            attrs = {}
        haystack = f"{attrs.get('class', '')} {attrs.get('id', '')} {attrs.get('role', '')}"
        if haystack.strip() and _BOILERPLATE_HINTS.search(haystack):
            return True
        current = getattr(current, "parent", None)
    return False


def _link_density(node: DomNode) -> float:
    text = node.text()
    if not text:
        return 1.0
    link_text = sum(len(a.text()) for a in node.css("a", limit=50))
    return min(link_text / len(text), 1.0)


def _descendant_signatures(node: DomNode, *, cap: int = MAX_RECORD_NODES) -> dict[str, DomNode]:
    """Map structural signature → first node, for one record container."""
    found: dict[str, DomNode] = {}
    for child in node.css("*", limit=cap):
        tag = child.tag
        if tag in _BOILERPLATE_TAGS:
            continue
        classes = child.attr("class") or ""
        tokens = sorted({c for c in classes.split() if c and len(c) < 40})
        signature = f"{tag}#{'.'.join(tokens)}"
        # An `a` element with no classes would collide with every other bare `a`;
        # qualify by its href shape so the "link" field is meaningful.
        if tag == "a" and not tokens:
            href = child.attr("href") or ""
            signature = f"a#{'internal' if href.startswith('/') else 'external'}"
        found.setdefault(signature, child)
    return found


class _Group:
    __slots__ = ("signature", "nodes", "score", "selector")

    def __init__(self, signature: str, selector: str) -> None:
        self.signature = signature
        self.selector = selector
        self.nodes: list[DomNode] = []
        self.score = 0.0


def _build_group_selector(sample: DomNode) -> str:
    classes = sample.attr("class") or ""
    tokens = [c for c in classes.split() if c and len(c) < 40 and re.fullmatch(r"[A-Za-z_][\w-]*", c)]
    # Class names containing digits are very often positional (col-3, item-12)
    # and would make the selector match only one record.
    stable = [c for c in tokens if not re.search(r"\d", c)][:3]
    if stable:
        return sample.tag + "." + ".".join(stable)
    return sample.tag


def find_repeating_groups(dom: Dom, *, min_count: int = MIN_RECORDS, top_n: int = 5) -> list[_Group]:
    """Candidate record containers, best first."""
    groups: dict[str, _Group] = {}
    inspected = 0

    for node in dom.css("body *", limit=MAX_CANDIDATE_NODES):
        inspected += 1
        tag = node.tag
        if tag in _BOILERPLATE_TAGS or tag in {"br", "hr", "img", "meta", "link", "input", "button", "label", "option"}:
            continue
        text = node.text()
        if len(text) < 10 or len(text) > 20_000:
            continue
        if _has_boilerplate_ancestor(node):
            continue

        signature = _node_signature(node)
        group = groups.get(signature)
        if group is None:
            group = _Group(signature, _build_group_selector(node))
            groups[signature] = group
        group.nodes.append(node)

    candidates: list[_Group] = []
    for group in groups.values():
        if len(group.nodes) < min_count:
            continue

        sample = group.nodes[0]
        texts = [n.text() for n in group.nodes[:20]]
        average_length = sum(len(t) for t in texts) / max(len(texts), 1)
        if average_length < 20:
            continue

        link_density = _link_density(sample)
        if link_density > 0.75:
            continue  # a nav/menu/footer list, not data

        field_count = len(_descendant_signatures(sample))
        if field_count < 2:
            continue

        # Balance: many records × several fields, penalised by link density.
        # The sqrt keeps a 500-item list from steamrolling a 6-item one that has
        # richer per-record structure.
        group.score = (len(group.nodes) ** 0.5) * field_count * (1.0 - link_density)
        candidates.append(group)

    candidates.sort(key=lambda g: g.score, reverse=True)
    logger.debug("Evaluated %s nodes, %s candidate groups", inspected, len(candidates))
    return candidates[:top_n]


def _field_name_for(node: DomNode, index: int, used: set[str]) -> str:
    haystack = f"{node.attr('class') or ''} {node.attr('id') or ''} {node.attr('itemprop') or ''} {node.attr('data-testid') or ''}"
    for pattern, name in _FIELD_NAME_HINTS:
        if pattern.search(haystack) and name not in used:
            return name

    tag = node.tag
    if tag == "a":
        base = "url"
    elif tag == "img":
        base = "image"
    elif tag == "time":
        base = "date"
    elif tag in {"h1", "h2", "h3", "h4"}:
        base = "title"
    else:
        base = "field"

    candidate = base
    counter = 1
    while candidate in used:
        counter += 1
        candidate = f"{base}_{counter}"
    return candidate


def _value_for_node(node: DomNode, base_url: str) -> tuple[Any, str]:
    """Extract a value plus an inferred field type from a representative node."""
    tag = node.tag
    if tag == "img":
        for attribute in ("src", "data-src", "data-lazy-src", "srcset"):
            raw = node.attr(attribute)
            if raw:
                if attribute == "srcset":
                    raw = raw.split(",")[0].strip().split(" ")[0]
                from ..core.text import absolutize

                return absolutize(raw, base_url) or raw, "image"
        return None, "text"

    if tag == "a":
        href = node.attr("href")
        text = node.text()
        if href and not text:
            from ..core.text import absolutize

            return absolutize(href, base_url) or href, "url"
        if href and text:
            return text, "text"
        return text, "text"

    if tag == "time":
        raw = node.attr("datetime") or node.text()
        return (parse_date(raw) or clean_text(raw)), "date"

    text = node.text()
    return text, "text"


def infer_fields(
    group: _Group,
    *,
    base_url: str,
) -> tuple[list[dict[str, Any]], list[str], float]:
    """Derive per-field selectors by finding descendants common to most records."""
    records = group.nodes[:50]
    if not records:
        return [], [], 0.0

    signature_hits: dict[str, list[DomNode | None]] = defaultdict(list)
    for record in records:
        present = _descendant_signatures(record)
        for signature, node in present.items():
            signature_hits[signature].append(node)
        for signature in list(signature_hits):
            if signature not in present and len(signature_hits[signature]) < len(records):
                signature_hits[signature].append(None)

    coverage: list[tuple[str, float, list[DomNode | None]]] = []
    for signature, nodes in signature_hits.items():
        present = [n for n in nodes if n is not None]
        ratio = len(present) / len(records)
        if ratio < FIELD_COVERAGE_THRESHOLD:
            continue

        # A field must be a *leaf-ish* value: a container that merely wraps the
        # whole record would otherwise be chosen as a "field" and duplicate data.
        sample = present[0]
        sample_text = sample.text()
        record_text = records[0].text()
        if record_text and len(sample_text) > 0.8 * len(record_text) and len(records[0].css("*", limit=50)) > 3:
            continue
        if not sample_text and sample.tag not in {"img", "a"}:
            continue

        coverage.append((signature, ratio, nodes))

    # Rank fields: prefer text/image over bare links, then coverage, then order.
    def rank(item: tuple[str, float, list[DomNode | None]]) -> tuple[float, float, int]:
        signature, ratio, nodes = item
        tag = signature.split("#", 1)[0]
        tag_priority = {"h1": 0, "h2": 0, "h3": 1, "time": 1, "img": 1, "span": 2, "a": 3, "div": 4, "p": 2}.get(tag, 3)
        return (tag_priority, -ratio, 0)

    coverage.sort(key=rank)

    fields: list[dict[str, Any]] = []
    used_names: set[str] = set()
    samples: dict[str, list[Any]] = {}
    total_coverage = 0.0

    for signature, ratio, nodes in coverage[: MAX_FIELDS * 2]:
        present = [n for n in nodes if n is not None]
        if not present:
            continue
        sample = present[0]
        values: list[Any] = []
        for node in present[:25]:
            value, _ = _value_for_node(node, base_url)
            if value not in (None, ""):
                values.append(value)
        if len(values) < 2:
            continue

        name = _field_name_for(sample, len(fields), used_names)
        used_names.add(name)

        field_type = infer_type(values)
        if field_type == "number" and name in {"title", "description", "url", "image", "author"}:
            field_type = "text"

        selector = _selector_for_signature(signature, sample)
        fields.append(
            {
                "name": name,
                "selector": selector,
                "type": field_type,
                "coverage": round(ratio, 2),
            }
        )
        samples[name] = values[:25]
        total_coverage += ratio

        if len(fields) >= MAX_FIELDS:
            break

    # Drop fields that are pure duplicates of another field's values.
    deduped: list[dict[str, Any]] = []
    seen_values: list[set[str]] = []
    for field in fields:
        value_set = {clean_text(str(v))[:120] for v in samples.get(field["name"], [])}
        if value_set and any(value_set and value_set == existing for existing in seen_values):
            continue
        seen_values.append(value_set)
        deduped.append(field)

    confidence = (total_coverage / max(len(deduped), 1)) if deduped else 0.0
    return deduped, list(used_names), round(min(confidence, 1.0), 3)


def _selector_for_signature(signature: str, sample: DomNode) -> str:
    """Build a scoped selector from a signature: ``tag.stable.classes``."""
    tag = signature.split("#", 1)[0]
    attrs = signature.split("#", 1)[1] if "#" in signature else ""
    tokens = [t for t in attrs.split(".") if t]
    stable = [t for t in tokens if not re.search(r"\d", t) and re.fullmatch(r"[A-Za-z_][\w-]*", t)][:2]
    selector = tag + ("." + ".".join(stable) if stable else "")
    return selector or tag


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def extract_auto(
    dom: Dom,
    spec: ExtractSpec,
    *,
    base_url: str,
    json_ld: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> ExtractionResult:
    result = ExtractionResult(strategy="auto")
    blocks = json_ld if json_ld is not None else extract_json_ld(dom)

    # --- pass 1: structured data --------------------------------------
    structured = records_from_json_ld(blocks)
    if structured:
        result.records = structured[: spec.max_records]
        result.confidences = [0.95] * len(result.records)
        result.diagnostics["source"] = "json_ld"
        result.diagnostics["records"] = len(result.records)
        if spec.dedupe_by:
            from .selectors import _dedupe

            result.records, result.confidences = _dedupe(result.records, result.confidences, spec.dedupe_by)
        return result

    # --- pass 3: repeated structure (run before meta, which always "succeeds"
    #     for exactly one record and would mask a real list) ------------
    groups = find_repeating_groups(dom)
    best_records: list[dict[str, Any]] = []
    best_confidence = 0.0
    best_fields: list[dict[str, Any]] = []
    best_group: _Group | None = None

    for group in groups:
        fields, names, confidence = infer_fields(group, base_url=base_url)
        if not fields:
            continue

        records: list[dict[str, Any]] = []
        for container in group.nodes[: spec.max_records]:
            record: dict[str, Any] = {}
            for field in fields:
                nodes = container.css(field["selector"], limit=5)
                value: Any = None
                if nodes:
                    raw, _ = _value_for_node(nodes[0], base_url)
                    value = raw
                if value in (None, ""):
                    continue
                if field["type"] == "number":
                    numeric = parse_number(value)
                    value = numeric if numeric is not None else value
                elif field["type"] == "date":
                    value = parse_date(value) or clean_text(str(value))
                elif isinstance(value, str):
                    value = clean_text(value)
                record[field["name"]] = value
            if len(record) >= 2:
                records.append(record)

        if len(records) < MIN_RECORDS:
            continue

        score = confidence * (len(records) ** 0.25)
        if score > best_confidence or not best_records:
            best_records, best_confidence, best_fields, best_group = records, confidence, fields, group

        if confidence >= 0.8 and len(records) >= MIN_RECORDS:
            break  # good enough; stop paying for more tree walks

    if best_records and best_confidence >= spec.min_confidence:
        result.records = best_records[: spec.max_records]
        result.confidences = [best_confidence] * len(result.records)
        result.diagnostics.update(
            source="repeated_structure",
            records=len(result.records),
            list_selector=best_group.selector if best_group else None,
            field_count=len(best_fields),
        )
        # Hand back a runnable, deterministic config: this is what turns a
        # one-off auto-extract into a saved recipe.
        result.suggested_config = {
            "strategy": "selectors",
            "listSelector": best_group.selector if best_group else None,
            "fields": [
                {"name": f["name"], "selector": f["selector"], "type": f["type"]}
                for f in best_fields
            ],
            "confidence": best_confidence,
        }
        if spec.dedupe_by:
            from .selectors import _dedupe

            result.records, result.confidences = _dedupe(result.records, result.confidences, spec.dedupe_by)
        return result

    # --- pass 2: page-level metadata ----------------------------------
    if metadata:
        record = record_from_metadata(metadata)
        if len(record) >= 3:
            result.records = [record]
            result.confidences = [0.6]
            result.diagnostics.update(source="metadata", records=1)
            return result

    result.warnings.append("auto_extraction_found_nothing")
    result.diagnostics.update(
        source="none",
        records=0,
        candidate_groups=len(groups),
        hint="Supply extract.fields directly, or enable AI extraction (ai.enrich) for ambiguous pages.",
    )
    return result
