# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Webscraper worker
#
# Multi-stage: the builder compiles the shared package and the worker with
# dev dependencies present; the runtime image keeps only production
# dependencies and the compiled JavaScript. No build tools ship to production.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Manifests first: dependency installation is the slowest layer and only needs
# to be invalidated when a lockfile changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN npm ci --workspace @webscraper/shared --workspace @webscraper/worker --include-workspace-root

# Sources, then build: shared first, because the worker imports its types.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN npm --workspace @webscraper/shared run build \
 && npm --workspace @webscraper/worker run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# `dumb-init` reaps zombies and forwards signals to the worker, which is what
# makes the graceful shutdown in src/index.ts actually run under Docker.
RUN apk add --no-cache dumb-init \
 && addgroup -g 1001 -S worker \
 && adduser -u 1001 -S worker -G worker

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
# `--ignore-scripts` because the shared workspace's `prepare` script runs `tsc`,
# which is a devDependency and therefore absent here. The compiled output is
# copied from the builder stage instead, which is the same artefact.
RUN npm ci --omit=dev --ignore-scripts --workspace @webscraper/shared --workspace @webscraper/worker --include-workspace-root \
 && npm cache clean --force

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/worker/dist apps/worker/dist

USER worker
EXPOSE 9090

# The health server reports engine reachability and queue depth; a worker that
# cannot reach Redis or the engine is not healthy, even if the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/worker/dist/index.js"]
