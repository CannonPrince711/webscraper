"""HTML parsing: DOM access, metadata extraction, link graph, article text.

Parsing is separated from extraction on purpose. The parse layer answers
"what is in this document?" and knows nothing about user intent; the extract
layer answers "what did the user ask for?" and never touches a raw socket.
"""

from .dom import Dom, parse_html  # noqa: F401
