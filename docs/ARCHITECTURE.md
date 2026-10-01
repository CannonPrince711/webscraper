# Architecture Overview

> **Webscraper** — an AI-powered scraping platform. Four independently deployable
> pieces, one Postgres backbone, and a demo mode that runs the whole thing with
> zero credentials.

---

## 1. Design principles

| Principle | What it means in this codebase |
|---|---|
| **Separation of concerns** | The Python engine *fetches and parses*. The Node worker *orchestrates and enriches*. Next.js *renders and brokers*. Postgres *is the source of truth*. No layer reaches around another. |
| **Stateless compute** | `web`, `worker`, and `engine` hold no session state. All state lives in Supabase (or the local JSON store in demo mode), so every tier scales horizontally and can be killed at any moment. |
| **Fail closed on egress** | Because "fetch this URL" is the entire product, the engine treats every URL as hostile until the SSRF guard clears it — including after every redirect and after DNS resolution. |
| **Specify once, run anywhere** | A scrape is a declarative `ScrapeConfig` (JSON, versioned, validated by Zod *and* Pydantic). The same object drives manual runs, cron schedules, and public API calls. |
| **Graceful degradation** | No Supabase → local JSON store. No Redis → inline execution. No LLM key → deterministic heuristic extraction. The UI never white-screens because an integration is missing. |
| **Untrusted-by-default data** | Scraped HTML is never rendered as HTML in our origin. It is sanitised, stored in a bucket, and displayed as text/JSON or in a sandboxed iframe. |

---

## 2. System diagram

```
                         ┌───────────────────────────────────────────────┐
   Browser  ────────────▶│  apps/web  ·  Next.js 16 (App Router)         │
   (dark-mode UI)        │  · React Server Components + Tailwind v4      │
                         │  · Supabase Auth (cookie sessions)            │
                         │  · /api/* route handlers = BFF layer          │
                         │  · Realtime subscription → live job progress  │
                         └───────┬───────────────────────┬───────────────┘
                                 │                       │
                    enqueue job  │                       │ server-side fetch
                                 ▼                       ▼
                    ┌────────────────────┐   ┌──────────────────────────┐
                    │  Redis  (BullMQ)   │   │  services/engine          │
                    │  queues:           │   │  Python · FastAPI         │
                    │   scrape, crawl,   │   │  · httpx / Playwright     │
                    │   ai, deliver,     │   │  · SSRF guard + robots    │
                    │   schedule (repeat)│   │  · selectolax parsing     │
                    └─────────┬──────────┘   │  · CSS/auto/LLM extract   │
                              │              │  · /v1/scrape /v1/crawl   │
                              ▼              └───────────┬──────────────┘
                    ┌────────────────────┐               │
                    │  apps/worker       │───────────────┘
                    │  Node.js · BullMQ  │  calls engine over HTTP,
                    │  · crawl frontier  │  HMAC-signed + API key
                    │  · AI enrichment   │
                    │  · webhook delivery│
                    │  · artifact upload │
                    └─────────┬──────────┘
                              │
                              ▼
     ┌────────────────────────────────────────────────────────────────┐
     │  Supabase                                                      │
     │  Postgres + RLS   ·   Auth   ·   Storage (artifacts/exports)   │
     │  Realtime         ·   Edge Functions (optional cron dispatcher)│
     └────────────────────────────────────────────────────────────────┘
```

---

## 3. Component responsibilities

### `apps/web` — Next.js 16 (Node.js runtime)

**Owns:** UI, session, authorisation, job creation, realtime presentation, BFF.

- **RSC-first.** Lists, KPIs and detail pages render on the server with the user's
  session; interactive bits (wizard, tables, live log) are client components.
- **BFF, not a proxy.** `/api/*` handlers validate input with Zod, resolve the
  caller's org, and *then* talk to Redis/Supabase/the engine. The browser never
  receives the service-role key or the engine API key.
- **Two clients, two trust levels.** The anon client (RLS-enforced, user-scoped)
  is the default. The service-role client is imported only in server-only modules
  and is used for engine callbacks and webhook fan-out.
- **Auth.** Supabase Auth with cookie-based sessions refreshed in middleware.
  Every request is re-validated server-side with `getUser()` — never trusted from
  a JWT payload alone.

### `services/engine` — Python / FastAPI

**Owns:** the network. Fetching, rendering, parsing, extracting, screenshotting.

- Pure functions over `(URL, ScrapeConfig) → PageResult`. No database writes, no
  business logic about users. This is what makes it trivially testable and safe
  to run at high concurrency.
- **Two fetchers, one interface.** `HttpFetcher` (httpx, pooled, retries) handles
  the ~80% of targets that are static HTML at a fraction of the cost.
  `BrowserFetcher` (Playwright/Chromium) is used when `render: "js"` is requested
  or when the static fetch looks like an unresolved SPA shell.
- **Security kernel:** `core/ssrf.py` (IP/CIDR allow-listing, redirect
  re-validation, DNS-rebinding defence), `core/robots.py` (cached directives +
  crawl-delay), `core/ratelimit.py` (per-domain token bucket).
- **Extractors:** `selectors` (deterministic, cheap, exact), `auto` (structural
  heuristics — finds repeating record boundaries without an LLM), `llm` (schema
  inference and natural-language → selector, when a key is configured).

### `apps/worker` — Node.js / BullMQ

**Owns:** long-running work. Anything that must survive a page refresh or a
serverless timeout.

- **Crawl frontier.** Breadth-first with per-domain politeness, dedupe by
  normalised URL + content hash, depth/scope limits, and a resumable frontier in
  Redis so a crash resumes rather than restarts.
- **AI enrichment.** Summaries, entity extraction, classification, and embedding
  generation. Batched, cached by content hash, and hard-capped by
  `AI_MAX_TOKENS_PER_JOB`.
- **Delivery.** CSV/JSONL export materialisation into Supabase Storage, and
  signed webhook delivery with exponential backoff and a delivery ledger.

### `supabase/` — data plane

Postgres schema, Row Level Security, triggers, and Storage policies. Every table
is scoped to an `org_id`; access is granted through `org_members`, so a leaked
anon key still cannot read another tenant's data. See §5.

---

## 4. Primary data flows

### 4.1 Create and run a scrape

```
1  User submits the wizard (client component)
2  POST /api/jobs          Zod validate → resolve org → insert `jobs` row (status=queued)
3  enqueue("scrape", {jobId, orgId, runId}) into Redis     [or run inline in demo mode]
4  worker picks it up → PATCH run status=running → engine POST /v1/scrape
5  engine: SSRF guard → robots → fetch (http|browser) → parse → extract
6  worker: normalise rows → upsert `records` (dedupe on content_hash)
           → upload html/screenshot to Storage → write `pages`
7  worker: fan-out (change detection, webhooks, AI enrichment if requested)
8  run status=succeeded, stats aggregated → Postgres Realtime broadcast
9  Browser: subscription pushes the delta into the live progress view
```

### 4.2 Crawl

The worker owns a Redis-backed frontier. Each dequeued URL becomes one engine
call; newly discovered in-scope links are pushed back onto the frontier with
`depth+1`. Per-domain rate limiting is enforced in the worker (politeness
ceiling) *and* in the engine (hard ceiling), so a bug in one cannot hammer a
target. A crawl is resumable: the frontier, visited set, and counters are all in
Redis, and the job row records the checkpoint.

### 4.3 AI enrichment

```
content_hash ──▶ cache lookup ──hit──▶ reuse previous output (free)
                        │
                        └─miss─▶ LLM (OpenAI-compatible) ──▶ validate against
                                   JSON schema ──▶ repair-once ──▶ persist
```
Enrichment is always **additive**: it writes to `records.enriched` and never
overwrites the deterministic `records.data`. If the LLM is unavailable, the
deterministic pipeline result stands on its own.

---

## 5. Data model

```
organizations ──┬── org_members (user_id, role: owner|admin|member|viewer)
                ├── projects ──┬── jobs ──┬── job_runs
                │              │          ├── pages ── records
                │              │          └── schedules (cron, next_run_at)
                │              └── recipes (reusable ScrapeConfig templates)
                ├── api_keys        (sha256 hash only, scopes[], last_used_at)
                ├── webhooks ─────── webhook_deliveries (attempt ledger)
                ├── proxies         (encrypted credential blob)
                ├── monitors        (change detection + alert rules)
                └── usage_events    (quota + billing substrate)
```

Key indexes: `records(org_id, job_id, created_at desc)`,
`pages(job_id, url)`, `jobs(org_id, status, created_at desc)`, plus a GIN index on
`records.data` for JSONB search. Full SQL: [`supabase/migrations`](../supabase/migrations).

---

## 6. The `ScrapeConfig` contract

Every execution path funnels through one versioned object — validated by Zod in
TypeScript and by Pydantic in Python, so drift between languages fails loudly at
the boundary rather than silently at runtime.

```jsonc
{
  "version": 1,
  "targets": ["https://example.com/products"],
  "mode": "single",                    // single | crawl | sitemap | batch
  "crawl": { "maxDepth": 2, "maxPages": 100, "sameDomain": true,
             "include": ["/products/**"], "exclude": ["/cart/**"] },
  "fetch": { "render": "auto", "waitFor": null, "timeoutMs": 30000,
             "respectRobots": true, "proxy": "pool-1", "headers": {} },
  "extract": {
    "strategy": "auto",                // auto | selectors | llm | recipe
    "fields": [
      { "name": "title", "selector": "h1", "type": "text", "required": true },
      { "name": "price", "selector": ".price", "type": "number", "transform": ["trimCurrency"] }
    ],
    "listSelector": ".product-card",
    "schema": null                     // JSON Schema for LLM mode
  },
  "ai": { "enrich": ["summary", "entities"], "model": "gpt-4o-mini" },
  "limits": { "maxPages": 5000, "maxBytesPerPage": 5000000 }
}
```

---

## 7. Deployment topology

| Tier | Recommended host | Notes |
|---|---|---|
| `web` | Vercel | Native Next.js; set env vars per environment. |
| `worker` | Fly.io / Railway / Render | Needs a persistent process + Redis. 1–N replicas; BullMQ handles distribution. |
| `engine` | Fly.io machine pool w/ tuned image | Chromium needs ~1GB RAM per 5 concurrent pages. Scale on queue depth. |
| `redis` | Upstash / ElastiCache | `maxmemory-policy noeviction` — evicting a queue key loses work. |
| Postgres/Auth/Storage | Supabase | Enable PITR for production. |

**Scaling signal:** queue depth and `job_runs.duration_ms` p95. The engine is
CPU/RAM-bound on rendering; the worker is I/O-bound and scales cheaply.

---

## 8. Known trade-offs

- **Two languages.** Justified: Python's parsing/rendering ecosystem
  (Playwright, selectolax, trafilatura) is materially better than Node's for
  this workload, and isolating network egress into one auditable service is a
  security win. The cost is a serialisation boundary, mitigated by the shared
  `ScrapeConfig` contract and generated types.
- **Heuristic extraction before LLM.** LLM-only extraction is simpler to write
  but 10–100× more expensive per page and non-deterministic. Structure-first,
  LLM-second keeps unit costs low and results reproducible.
- **Realtime over polling.** Supabase Realtime means a long crawl needs no
  polling loop, at the cost of a websocket per open tab. Falls back to polling
  in demo mode.
