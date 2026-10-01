"""A small DOM facade over two parsers.

Why two? `selectolax` (Lexbor) is the fastest HTML parser available in Python
and handles the malformed markup that real sites ship; `lxml` is needed only
for XPath, which a handful of power users rely on. Both are wrapped behind one
`Node` interface so the extraction layer never branches on which parser
produced a node.

Security note: nothing here executes JavaScript, resolves entities beyond what
the parsers do by default, or fetches remote DTDs. `lxml.html` does not process
external entities, and selectolax has no entity expansion at all.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Iterator, Sequence
from typing import Any

from selectolax.parser import HTMLParser

from ..core.text import clean_text, strip_html

logger = logging.getLogger(__name__)

_WHITESPACE_RE = re.compile(r"\s+")


class DomNode:
    """Uniform read-only view over a selectolax or lxml node."""

    __slots__ = ("_node", "_kind", "_dom")

    def __init__(self, node: Any, kind: str, dom: Dom) -> None:
        self._node = node
        self._kind = kind
        self._dom = dom

    # --- text ---------------------------------------------------------
    def text(self, *, deep: bool = True, separator: str = " ") -> str:
        if self._kind == "css":
            try:
                raw = self._node.text(deep=deep, separator=separator, strip=False)
            except TypeError:  # older selectolax signature
                raw = self._node.text(deep=deep)
        else:
            raw = self._node.text_content() if deep else (self._node.text or "")
            if separator != " ":
                raw = raw.replace("\n", separator)
        return clean_text(raw)

    def raw_text(self) -> str:
        """Text without whitespace collapsing — preserves paragraph breaks."""
        if self._kind == "css":
            try:
                return self._node.text(deep=True, separator="\n", strip=False) or ""
            except TypeError:  # pragma: no cover
                return self._node.text(deep=True) or ""
        return self._node.text_content() or ""

    # --- attributes ---------------------------------------------------
    def attr(self, name: str) -> str | None:
        if self._kind == "css":
            value = self._node.attributes.get(name)
        else:
            value = self._node.get(name)
        return value

    def attrs(self) -> dict[str, str]:
        if self._kind == "css":
            return dict(self._node.attributes)
        return {str(k): str(v) for k, v in self._node.attrib.items()}

    @property
    def tag(self) -> str:
        raw = self._node.tag if self._kind == "css" else self._node.tag
        return str(raw).lower()

    # --- html ---------------------------------------------------------
    def inner_html(self) -> str:
        if self._kind == "css":
            try:
                return self._node.html or ""
            except Exception:  # pragma: no cover
                return ""
        from lxml import etree

        return "".join(
            etree.tostring(child, encoding="unicode", method="html") for child in self._node
        ) or (self._node.text or "")

    def outer_html(self) -> str:
        if self._kind == "css":
            return f"<{self.tag}>{self.inner_html()}</{self.tag}>"
        from lxml import etree

        return etree.tostring(self._node, encoding="unicode", method="html")

    def html(self, *, include_self: bool = False) -> str:
        return self.outer_html() if include_self else self.inner_html()

    def stripped_text(self) -> str:
        return strip_html(self.outer_html())

    # --- traversal ----------------------------------------------------
    def css(self, selector: str, limit: int = 500) -> list[DomNode]:
        if self._kind == "css":
            try:
                found = self._node.css(selector)
            except Exception as exc:
                logger.debug("Invalid CSS selector %r: %s", selector, exc)
                return []
            return [DomNode(n, "css", self._dom) for n in found[:limit]]
        # lxml node: delegate to the document-level XPath translation.
        return self._dom._xpath_on(self, selector, limit)

    def css_first(self, selector: str) -> DomNode | None:
        found = self.css(selector, limit=1)
        return found[0] if found else None

    def xpath(self, expression: str, limit: int = 500) -> list[DomNode]:
        if self._kind == "css":
            return self._dom._xpath_on(self, expression, limit, is_xpath=True)
        try:
            results = self._node.xpath(expression)
        except Exception as exc:
            logger.debug("Invalid XPath %r: %s", expression, exc)
            return []
        return [DomNode(r, "xpath", self._dom) for r in _coerce_xpath(results)[:limit]]

    def xpath_first(self, expression: str) -> DomNode | None:
        found = self.xpath(expression, limit=1)
        return found[0] if found else None

    # --- misc ---------------------------------------------------------
    @property
    def raw(self) -> Any:
        return self._node

    def is_empty(self) -> bool:
        return not self.text() and not self.inner_html().strip()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<DomNode {self.tag} text={self.text()[:40]!r}>"


def _coerce_xpath(results: Any) -> list[Any]:
    """XPath can return strings/numbers; wrap them so the Node API still works."""
    if not isinstance(results, list):
        results = [results]
    out: list[Any] = []
    for item in results:
        out.append(_StringElement(str(item)) if isinstance(item, (str, int, float)) else item)
    return out


class _StringElement:
    """A fake lxml element so a text()/attribute XPath result stays usable."""

    def __init__(self, value: str) -> None:
        self.tag = "_text"
        self.text = value
        self.attrib: dict[str, str] = {}
        self._value = value

    def text_content(self) -> str:
        return self._value

    def get(self, _name: str) -> None:
        return None

    def __iter__(self) -> Iterator[Any]:
        return iter(())

    def xpath(self, _expr: str) -> list[Any]:  # pragma: no cover
        return []


class Dom:
    """A parsed document with both CSS and XPath access."""

    __slots__ = ("html", "_css_tree", "_lxml_tree", "_root")

    def __init__(self, html: str) -> None:
        self.html = html
        self._css_tree: HTMLParser | None = None
        self._lxml_tree: Any = None
        self._root: DomNode | None = None

    # --- CSS ----------------------------------------------------------
    @property
    def css_tree(self) -> HTMLParser:
        if self._css_tree is None:
            self._css_tree = HTMLParser(self.html)
        return self._css_tree

    def css(self, selector: str, limit: int = 500, *, strict: bool = False) -> list[DomNode]:
        try:
            found = self.css_tree.css(selector)
        except Exception as exc:
            logger.debug("Invalid CSS selector %r: %s", selector, exc)
            if strict:
                raise ValueError(f"invalid CSS selector: {selector}") from exc
            return []
        return [DomNode(n, "css", self) for n in found[:limit]]

    def css_first(self, selector: str) -> DomNode | None:
        found = self.css(selector, limit=1)
        return found[0] if found else None

    def css_count(self, selector: str, cap: int = 1000) -> int:
        """Count matches without materialising nodes (cheap cap for UI probes)."""
        try:
            return min(len(self.css_tree.css(selector)), cap)
        except Exception:
            return 0

    # --- XPath --------------------------------------------------------
    @property
    def lxml_tree(self) -> Any:
        if self._lxml_tree is None:
            from lxml import html as lxml_html

            try:
                self._lxml_tree = lxml_html.fromstring(self.html)
            except Exception:  # pragma: no cover - selectolax is more forgiving
                self._lxml_tree = lxml_html.fromstring("<html><body></body></html>")
        return self._lxml_tree

    def xpath(self, expression: str, limit: int = 500, *, strict: bool = False) -> list[DomNode]:
        try:
            results = self.lxml_tree.xpath(expression)
        except Exception as exc:
            logger.debug("Invalid XPath %r: %s", expression, exc)
            if strict:
                raise ValueError(f"invalid XPath: {expression}") from exc
            return []
        return [DomNode(r, "xpath", self) for r in _coerce_xpath(results)[:limit]]

    def xpath_first(self, expression: str) -> DomNode | None:
        found = self.xpath(expression, limit=1)
        return found[0] if found else None

    def _xpath_on(self, node: DomNode, expression: str, limit: int, *, is_xpath: bool = False) -> list[DomNode]:
        """Run an XPath against a node that came from the CSS parser.

        selectolax nodes have no stable XPath bridge, so we re-run the
        expression against the lxml tree. Exact node identity is not preserved;
        the results are still complete for the whole document, which is what
        the field-level fallback path needs.
        """
        if is_xpath:
            return self.xpath(expression, limit)
        # A CSS selector arriving on an XPath node: translate via lxml.cssselect
        # when available, otherwise fall back to a document-level CSS query.
        try:
            from cssselect import GenericTranslator  # type: ignore

            translated = GenericTranslator().css_to_xpath(expression)
            return self.xpath(translated, limit)
        except Exception:
            return self.css(expression, limit)

    # --- document-level helpers --------------------------------------
    @property
    def root(self) -> DomNode:
        if self._root is None:
            body = self.css_first("body")
            self._root = body or DomNode(self.css_tree.root, "css", self)
        return self._root

    def select_any(self, selectors: Sequence[str], *, selector_type: str = "css", limit: int = 1) -> list[DomNode]:
        """First hit wins — the fallback chain for a field."""
        for selector in selectors:
            if not selector:
                continue
            found = self.xpath(selector, limit) if selector_type == "xpath" else self.css(selector, limit)
            if found:
                return found
        return []

    def title(self) -> str | None:
        node = self.css_first("title")
        if node:
            text = node.text()
            if text:
                return text
        meta = self.css_first("meta[property='og:title']")
        if meta:
            return meta.attr("content")
        return None

    def lang(self) -> str | None:
        node = self.css_first("html")
        return node.attr("lang") if node else None

    def all_headings(self, limit: int = 100) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for level in range(1, 7):
            for node in self.css(f"h{level}", limit=limit):
                text = node.text()
                if text:
                    out.append({"level": f"h{level}", "text": text[:300]})
                if len(out) >= limit:
                    return out
        return out

    def text_content(self) -> str:
        return self.root.text()

    def markdown(self, limit_chars: int | None = None) -> str:
        """Readability-style main-content extraction rendered as Markdown."""
        from .readability import extract_article

        return extract_article(self, limit_chars=limit_chars)


def parse_html(html: str) -> Dom:
    return Dom(html or "")


def parse_fragment(html: str) -> Dom:
    """Parse an HTML *fragment* (records extracted out of context)."""
    return Dom(f"<html><body>{html or ''}</body></html>")


def truncate_html(html: str, limit: int = 2_000_000) -> str:
    """Bound the document size handed to the parsers."""
    if len(html) <= limit:
        return html
    # Cut at a tag boundary so the parser sees well-formed-ish input.
    cut = html.rfind(">", 0, limit)
    return html[: cut + 1 if cut > 0 else limit]


def iter_nodes(nodes: Iterable[DomNode]) -> Iterator[DomNode]:
    yield from nodes
