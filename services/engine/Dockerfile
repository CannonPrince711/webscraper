# =============================================================================
#  Webscraper engine — FastAPI + Chromium
#
#  The official Playwright image is used as the base because the pip-installed
#  `playwright` package must match a browser build that exists on disk; pinning
#  both to the same tag is the only reliable way to guarantee that in CI.
#
#  Slimmer alternative: if you set ENGINE_ENABLE_BROWSER=false, swap the base
#  for `python:3.12-slim` and drop the browser layer — the image shrinks from
#  ~1.6 GB to ~180 MB and the HTTP path is unaffected.
# =============================================================================
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Dependencies first: this layer is cached across application-code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y playwright >/dev/null 2>&1 || true
# Reinstall the pinned Playwright that matches the base image's browsers.
RUN pip install --no-cache-dir "playwright==1.47.0"

COPY app ./app
COPY pyproject.toml ./

# --- least privilege --------------------------------------------------------
# A dedicated unprivileged user. Chromium's own sandbox is kept ENABLED (no
# --no-sandbox flag anywhere in the code) so a renderer exploit cannot escape
# into the engine process, let alone the host.
RUN groupadd --system --gid 1001 engine \
    && useradd --system --uid 1001 --gid engine --create-home engine \
    && chown -R engine:engine /app

USER engine

EXPOSE 8000

# Readiness is deliberately shallow here: /healthz never touches the network,
# so a slow dependency can't cause an orchestrator to kill a healthy pod.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--limit-concurrency", "256", \
     "--timeout-keep-alive", "15", \
     "--no-server-header", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*"]
