"""FastAPI dependencies: authentication and shared clients."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, Request

from .config import settings
from .core.security import SIGNATURE_HEADER, verify_api_key, verify_signature


async def require_engine_auth(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_webscraper_signature: Annotated[str | None, Header()] = None,
) -> None:
    """Authenticate a caller: bearer key, plus HMAC signature when required.

    The body is read here (Starlette caches it, so the route handler still
    receives its parsed model) because the signature covers the exact bytes the
    client sent. Verifying a re-serialised model instead would let a tampered
    body through whenever field order or float formatting changed.
    """
    verify_api_key(authorization)

    if settings.engine_require_signature:
        body = await request.body()
        verify_signature(x_webscraper_signature or request.headers.get(SIGNATURE_HEADER), body)


AuthDep = Annotated[None, Depends(require_engine_auth)]
