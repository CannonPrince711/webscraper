# Implementation Plan

Sequenced so that **something is demoable at the end of every phase**. Each phase
lists concrete deliverables and an exit criterion you can actually test.

Legend: ✅ shipped in this repository · 🔜 scaffolded, needs hardening

---

## Phase 0 — Foundations ✅

| # | Task | Exit criterion |
|---|---|---|
| 0.1 | npm-workspace monorepo (`apps/*`, `services/*`) | `npm install` at root links all workspaces |
| 0.2 | Shared env contract (`.env.example`) + typed config loaders | App boots with an empty `.env` in demo mode |
| 0.3 | TypeScript strict everywhere, ESLint, Prettier | `npm run typecheck && npm run lint` clean |
| 0.4 | Docker Compose for redis/engine/worker/web | `docker compose up` reaches a working UI |

**Exit:** `npm run dev` serves a dark-mode dashboard with no credentials configured.

---

## Phase 1 — Data plane ✅

| # | Task | Exit criterion |
|---|---|---|
| 1.1 | Migration `0001_init.sql` — orgs, members, projects, jobs, runs, pages, records | `supabase db reset` applies cleanly |
| 1.2 | Migration `0002_rls.sql` — enable RLS + tenant policies on every table | Cross-tenant read returns 0 rows |
| 1.3 | Migration `0003_functions.sql` — triggers, quota counters, realtime publication | New user gets an org automatically |
| 1.4 | Storage buckets + object policies (`artifacts`, `exports`) | Upload path is namespaced by `org_id` |
| 1.5 | `types/database.ts` hand-maintained types | Query layer is fully typed |

**Exit:** two users in different orgs cannot see each other's jobs or records.

**Security gate:** every table has RLS *enabled* (not just policies written), and
`FORCE ROW LEVEL SECURITY` is set so table owners aren't exempt.

---

## Phase 2 — Scraping engine ✅

| # | Task | Exit criterion |
|---|---|---|
| 2.1 | FastAPI skeleton, pydantic-settings, structured logging, `/healthz` | `uvicorn app.main:app` starts; `/docs` renders |
| 2.2 | **SSRF guard**: scheme/port allow-list, DNS resolution to public IPs, redirect re-validation, size + time caps | `curl` at `127.0.0.1` / `169.254.169.254` is rejected |
| 2.3 | `HttpFetcher` — pooling, retries w/ jitter, UA rotation, per-domain rate limit | 404/timeout/gzip/redirect handled without leaking connections |
| 2.4 | `BrowserFetcher` — Playwright, blocklists heavy assets, `waitFor` strategies | Renders a JS-only SPA and returns hydrated HTML |
| 2.5 | robots.txt cache + crawl-delay | Disallowed path returns a typed `BlockedByRobots` error |
| 2.6 | Parsers: CSS/XPath, readability→markdown, metadata (OG/JSON-LD), link graph | Fixture pages parse to expected output |
| 2.7 | Extractors: `selectors`, `auto` heuristics, `llm` | Auto-mode finds the repeated record set on a fixture listing page |
| 2.8 | API-key auth + HMAC body signature + per-org rate limit | Wrong signature → 401 |
| 2.9 | pytest suite incl. SSRF bypass attempts | `pytest -q` green |

**Exit:** `POST /v1/scrape` against a real product page returns clean structured JSON.

---

## Phase 3 — Orchestration ✅

| # | Task | Exit criterion |
|---|---|---|
| 3.1 | BullMQ queues: `scrape`, `crawl`, `ai`, `deliver`, `schedule` | Jobs enqueue and complete with retries |
| 3.2 | Redis crawl frontier (visited set, depth, dedupe, politeness) | A 3-level crawl visits each URL once |
| 3.3 | Inline executor fallback when `REDIS_URL` is unset | Demo mode still runs a full scrape |
| 3.4 | Engine client with timeouts, retries, circuit breaker | Engine down → job fails with an actionable error, not a hang |
| 3.5 | Change detection (content hash vs previous run) + `monitors` alerting | Second run reports `changed: 0` for a static page |
| 3.6 | Webhook delivery with HMAC signing, backoff, delivery ledger | Signature verifies in a reference receiver |

**Exit:** a scheduled job fires, crawls 100 pages, and the UI updates live.

---

## Phase 4 — Web UI ✅

| # | Task | Exit criterion |
|---|---|---|
| 4.1 | Design system: tokens, dark-first theming, `next-themes` toggle, no-flash script | Toggle persists across reloads; respects `prefers-color-scheme` |
| 4.2 | App shell: sidebar, command palette, breadcrumbs, toasts | Keyboard-navigable |
| 4.3 | Overview dashboard: KPI cards, throughput sparkline, recent runs | Renders from real data, skeletons while loading |
| 4.4 | Job wizard: target → mode → extraction → options → review | Validates with the same Zod schema the server uses |
| 4.5 | Job detail: live progress, stage timeline, log stream, results grid | Progress advances without a refresh |
| 4.6 | Data explorer: JSONB search, column picker, pagination, CSV/JSONL export | Export matches the filtered view |
| 4.7 | Settings: API keys, webhooks, proxies, AI provider, retention | Secrets shown once, then only a hash |
| 4.8 | Accessibility pass: focus rings, ARIA, reduced-motion, AA contrast | Lighthouse a11y ≥ 95 |

**Exit:** a non-technical user can go from sign-up to CSV export in under 3 minutes.

---

## Phase 5 — AI features ✅

| # | Task | Exit criterion |
|---|---|---|
| 5.1 | Provider abstraction over any OpenAI-compatible endpoint (no SDK lock-in) | Swapping `AI_BASE_URL` switches providers |
| 5.2 | **NL → ScrapeConfig**: "get product names and prices from this page" | Produces a valid, runnable config |
| 5.3 | **Schema inference** from sampled HTML | Generates a JSON Schema matching the page |
| 5.4 | **Heuristic fallback** (no key required): repeating-structure detection | Auto-extract works fully offline |
| 5.5 | Enrichment: summary, entities, classification, embeddings | Additive only — never overwrites deterministic data |
| 5.6 | Cost control: per-job token ceiling, content-hash cache, monthly USD cap | Exceeding the cap fails closed with a clear error |
| 5.7 | **Prompt-injection defence**: page text is data, never instructions; outputs schema-validated | A page saying "ignore previous instructions" changes nothing |

**Exit:** auto-extraction on a new marketplace page yields ≥ 90% field accuracy.

---

## Phase 6 — Hardening 🔜

- Structured logs → OpenTelemetry traces spanning web → worker → engine.
- `SENTRY_DSN` wiring, alert rules on run failure rate and queue depth.
- Load test: 10k records/min ingest, 500 concurrent engine calls.
- Chaos: kill the worker mid-crawl and assert resumption from the frontier.
- Backups + a rehearsed PITR restore.
- Dependency and container scanning in CI (`npm audit`, `pip-audit`, Trivy).

---

## Phase 7 — Product surface 🔜

- Public REST API + OpenAPI docs, per-key scopes and rate limits.
- Visual selector picker (click an element in a sandboxed preview → CSS path).
- Recipe marketplace (share/import `ScrapeConfig` templates).
- Team roles, invites, audit log export.
- Billing via Stripe: metered usage from `usage_events`, plan limits enforced in the worker.
- Slack / email / generic webhook alert channels.

---

## Phase 8 — Compliance 🔜

- Per-domain policy registry: ToS notes, robots overrides with a justification trail.
- PII detection and redaction on ingest; retention + deletion (GDPR erasure).
- DPA template, sub-processor list, data-processing records.
- Crawl-budget fairness so one tenant cannot monopolise the egress IPs.

---

## Definition of done (every phase)

1. Types check, lint passes, tests pass.
2. New env vars documented in `.env.example`.
3. Migrations are forward-only and idempotent.
4. No secret, token, or scraped personal data lands in a log line.
5. `docs/` updated in the same commit as the behaviour change.

---

## Suggested sequencing for a solo builder

| Week | Focus |
|---|---|
| 1 | Phases 0–2: engine that reliably fetches, renders and extracts one page |
| 2 | Phase 3: queue, crawl frontier, worker — make it multi-page |
| 3 | Phase 4: UI you'd actually want to use, dark mode first |
| 4 | Phase 5: AI features on top of the deterministic core |
| 5 | Phase 6–7: hardening, public API, billing |
| 6 | Phase 8: compliance and launch polish |

The ordering is deliberate: **a trustworthy extraction core before AI, and AI
before billing.** Selling a product whose accuracy you can't reason about is the
most expensive mistake available here.
