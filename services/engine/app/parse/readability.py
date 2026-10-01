"""Main-content extraction → Markdown.

Two implementations, one interface:

* **trafilatura** when installed — best-in-class boilerplate removal, tuned
  against real corpora, and it handles the awkward cases (multi-column layouts,
  comment sections, "related articles" rails).
* **A built-in density scorer** as the fallback, so the engine has no hard
  dependency on a research-grade library staying installable.

The output is Markdown rather than HTML because the consumer is either an LLM
(which reads Markdown well and cheaply) or a human in a UI. Raw HTML is
available separately via `Pages` artifacts for anyone who needs it.
"""

from __future__ import annotations

import logging
import re

from .dom import Dom, DomNode

logger = logging.getLogger(__name__)

_MAX_MARKDOWN_CHARS = 400_000

# Containers that almost always hold the main content, best first.
_CONTENT_SELECTORS: tuple[str, ...] = (
    "article",
    "main",
    "[role='main']",
    "#content",
    "#main",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".article-body",
    ".post-body",
    ".markdown-body",
    ".prose",
    "div.content",
)

# Boilerplate that must never reach the markdown body.
_NOISE_SELECTORS: tuple[str, ...] = (
    "script", "style", "noscript", "template", "svg", "iframe", "form",
    "nav", "footer", "header", "aside",
    "nav[aria-label]", "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    ".nav", ".navbar", ".menu", ".sidebar", ".footer", ".header", ".modal",
    ".cookie", ".cookies", ".cookie-banner", ".gdpr", ".consent",
    ".advertisement", ".ad", ".ads", ".advert", ".sponsor", ".promo",
    ".newsletter", ".subscribe", ".paywall", ".comments", ".comment-list",
    ".related", ".related-posts", ".recommended", ".share", ".social",
    ".breadcrumb", ".breadcrumbs", ".pagination", ".pager", ".tags",
    ".skip-link", ".screen-reader-text", ".visually-hidden",
)

_WS_RE = re.compile(r"[ \t\u00a0]+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")
_TAGS = re.compile(r"<[^>]+>")


def _trafilatura_markdown(html: str, url: str | None) -> str | None:
    try:
        import trafilatura  # type: ignore
    except ImportError:
        return None
    try:
        result = trafilatura.extract(
            html,
            url=url,
            output_format="markdown",
            include_links=True,
            include_images=False,
            include_tables=True,
            include_comments=False,
            include_formatting=True,
            favor_recall=False,
            deduplicate=True,
        )
        return result or None
    except Exception as exc:  # pragma: no cover - library internals
        logger.debug("trafilatura failed: %s", type(exc).__name__)
        return None


def _strip_noise(dom: Dom) -> None:
    """Remove boilerplate nodes in place so scoring sees only real content."""
    for selector in _NOISE_SELECTORS:
        for node in dom.css(selector, limit=200):
            try:
                node.raw.decompose()
            except Exception:
                # selectolax nodes support decompose(); lxml ones do not. Fall
                # back to detaching from the parent where possible.
                try:
                    parent = node.raw.getparent()
                    if parent is not None:
                        parent.remove(node.raw)
                except Exception:
                    pass


def _text_density(node: DomNode) -> float:
    text = node.text()
    if len(text) < 40:
        return 0.0
    paragraphs = len(node.css("p", limit=200))
    # Links are the strongest boilerplate signal: navigation is link-dense,
    # prose is not.
    link_text = sum(len(a.text()) for a in node.css("a", limit=200))
    link_ratio = link_text / max(len(text), 1)
    return (len(text) + paragraphs * 60) * (1.0 - min(link_ratio, 0.9))


def _pick_container(dom: Dom) -> DomNode:
    for selector in _CONTENT_SELECTORS:
        node = dom.css_first(selector)
        if node and len(node.text()) > 200:
            return node

    best: DomNode | None = None
    best_score = 0.0
    for node in dom.css("div, section", limit=400):
        score = _text_density(node)
        if score > best_score:
            best, best_score = node, score
    return best or dom.root


def _inline_markdown(node: DomNode) -> str:
    """Render inline children (a/strong/em/code/br) to Markdown."""
    parts: list[str] = []

    def walk(current: DomNode) -> None:
        tag = current.tag
        if tag in {"script", "style", "noscript", "svg", "iframe"}:
            return
        if tag == "a":
            href = current.attr("href")
            label = current.text()
            if href and label:
                parts.append(f"[{label}]({href})")
            elif label:
                parts.append(label)
            return
        if tag in {"strong", "b"}:
            text = current.text()
            if text:
                parts.append(f"**{text}**")
            return
        if tag in {"em", "i"}:
            text = current.text()
            if text:
                parts.append(f"*{text}*")
            return
        if tag in {"code", "kbd", "samp"}:
            text = current.text()
            if text:
                parts.append(f"`{text}`")
            return
        if tag in {"del", "s", "strike"}:
            text = current.text()
            if text:
                parts.append(f"~~{text}~~")
            return
        if tag == "br":
            parts.append("  \n")
            return
        if tag == "img":
            src, alt = current.attr("src"), current.attr("alt") or ""
            if src:
                parts.append(f"![{alt}]({src})")
            return

        children = [child for child in _children(current)]
        if children:
            for child in children:
                walk(child)
        else:
            text = current.text()
            if text:
                parts.append(text)

    walk(node)
    return _WS_RE.sub(" ", "".join(parts)).strip()


def _children(node: DomNode) -> list[DomNode]:
    if node.tag == "_text":
        return []
    return node.css("*", limit=500)


def _block_markdown(node: DomNode, depth: int = 0) -> str:
    """Convert a container's block children to Markdown."""
    if depth > 12:
        return ""
    out: list[str] = []
    stack = [node]
    while stack:
        current = stack.pop(0)
        for child in _children(current):
            tag = child.tag
            if tag in {"script", "style", "noscript", "svg", "iframe", "form", "nav", "footer", "aside"}:
                continue
            if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
                level = int(tag[1])
                text = _inline_markdown(child)
                if text:
                    out.append(f"{'#' * level} {text}")
            elif tag == "p":
                text = _inline_markdown(child)
                if text:
                    out.append(text)
            elif tag in {"ul", "ol"}:
                ordered = tag == "ol"
                for index, item in enumerate(child.css("li", limit=200), start=1):
                    text = _inline_markdown(item)
                    if text:
                        out.append(f"{index}. {text}" if ordered else f"- {text}")
            elif tag == "blockquote":
                text = child.text()
                if text:
                    out.append("\n".join(f"> {line}" for line in text.splitlines() if line.strip()))
            elif tag == "pre":
                code = child.css_first("code")
                text = (code or child).text(deep=True, separator="\n")
                if text:
                    out.append(f"```\n{text}\n```")
            elif tag == "table":
                table = _table_markdown(child)
                if table:
                    out.append(table)
            elif tag == "hr":
                out.append("---")
            elif tag in {"div", "section", "article", "main", "span", "label", "details", "summary"}:
                # Recurse into generic containers, keeping their text.
                text = _inline_markdown(child)
                has_blocks = bool(child.css("p, h1, h2, h3, h4, h5, h6, ul, ol, pre, table, blockquote", limit=1))
                if has_blocks:
                    stack.append(child)
                elif text:
                    out.append(text)
            else:
                text = _inline_markdown(child)
                if text:
                    out.append(text)
    return "\n\n".join(part for part in out if part.strip())


def _table_markdown(table: DomNode) -> str:
    rows = table.css("tr", limit=200)
    if not rows:
        return ""
    lines: list[str] = []
    for index, row in enumerate(rows):
        cells = [c.text() for c in row.css("th, td", limit=50)]
        if not cells:
            continue
        lines.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
        if index == 0:
            lines.append("| " + " | ".join("---" for _ in cells) + " |")
    return "\n".join(lines)


def extract_article(dom: Dom, *, url: str | None = None, limit_chars: int | None = None) -> str:
    """Main content as Markdown. Never returns None — worst case, page text."""
    limit = limit_chars or _MAX_MARKDOWN_CHARS

    markdown = _trafilatura_markdown(dom.html, url)
    if markdown and len(markdown) > 200:
        return markdown[:limit]

    working = Dom(dom.html)   # copy: noise removal must not mutate the caller's DOM
    _strip_noise(working)
    container = _pick_container(working)
    fallback = _block_markdown(container)
    if len(fallback) > 200:
        return fallback[:limit]

    # Last resort: the raw text of the document, whitespace-normalised.
    text = _TAGS.sub(" ", working.html)
    return _BLANK_LINES_RE.sub("\n\n", text)[:limit].strip()


def extract_plain_text(dom: Dom, limit_chars: int = 200_000) -> str:
    """De-tagged text, used for keyword search and short summaries."""
    text = _TAGS.sub(" ", dom.root.outer_html() if hasattr(dom.root, "outer_html") else dom.html)
    return _BLANK_LINES_RE.sub("\n\n", text)[:limit_chars].strip()
