"""Fetchers: a fast HTTP path and a browser path behind one interface."""

from .base import close_fetchers, fetch_page  # noqa: F401
from .http import HttpFetcher, http_fetcher  # noqa: F401

__all__ = ["fetch_page", "close_fetchers", "HttpFetcher", "http_fetcher"]
