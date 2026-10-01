# Webscraper

An AI-powered web scraping platform: a Next.js dashboard, a hardening-focused
Python scraping engine, and a Node.js worker for durable background jobs — with
optional Supabase for auth, Postgres and storage.

It runs with **zero credentials**. With an empty `.env` you get a complete,
usable product against a local JSON store; each credential you add turns on a
production capability without changing any code.

---

## Quick start

```bash
# 1. Node dependencies (also compiles the shared contract package)
npm install

# 2. Python engine
cd services/engine
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../..

# 3. Environment — works as-is, nothing to fill in
cp .env.example .env        # then: openssl rand -base64 32  → APP_SECRET, CRON_SECRET

# 4. Run both services
npm run dev:engine          # http://localhost:8000  (OpenAPI at /docs)
npm run dev                 # http://localhost:3000
```

Then open <http://localhost:3000>, press **New job**, and point it at any page.

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dashboard + API routes |
| `npm run dev:engine` | FastAPI scraping engine |
| `npm run dev:worker` | BullMQ worker (needs Redis + Supabase) |
| `npm test` | Shared contract + worker unit tests |
| `npm run test:engine` | Python engine test suite |
| `npm run typecheck` | `tsc --noEmit` across every TypeScript package |

## Windows desktop app

Download from the [Releases](../../releases) page, either:

- **`Webscraper-Setup.exe`** – unpacks the app into one folder you choose (default
  `Documents\Webscraper`). No registry entries, no uninstaller: delete the folder
  to remove it.
- **`Webscraper-windows-x64-portable.zip`** – the same folder, unzipped by you.

Run `Webscraper.exe`; your browser opens to the dashboard. Everything is in that
one folder:

```
Webscraper.exe   _internal\   data\
                  (program)     (your settings, secrets and scraped data)
```

- **Stop** – the red button in the header exits everything (dashboard, engine,
  running jobs are marked interrupted). Closing the browser tab does not stop it.
- **Settings → Variables** – edit AI provider, proxy (Decodo), engine and limit
  variables; saved to `data\.env`. Secrets are write-only. Changes apply on restart
  (there is a *Save & restart* button).
- **Settings → Updates / auto-update** – checks GitHub Releases at start-up and
  every few hours, verifies the download against `SHA256SUMS.txt`, swaps the
  program files and relaunches. `data\` is never touched. Turn off the start-up
  install with *Install updates automatically*.

Headless-Chromium rendering is off in the desktop build (no bundled browser).
Build it yourself with `./packaging/desktop/build_windows.ps1` (Node 20+, Python
3.11+), or push a `v*` tag and the **Build Webscraper** workflow builds, tests and
attaches `Setup.exe`, the zip and `SHA256SUMS.txt` to a release.

## Using residential proxies (Decodo)

Sites that block datacentre IPs need residential egress. The platform treats a
proxy as a **policy**, never a credential: a saved job says *"use Decodo, from
Germany, sticky for 10 minutes"*, and the username and password never leave the
engine's environment — so they cannot leak through an API response, an exported
job JSON, or a screenshot in a bug report.

1. Log in at <https://dashboard.decodo.com> → **Residential** → **Proxy setup**.
2. Copy the proxy **username** (starts with `user-`) and **password**.
3. Put them in the root `.env`:

   ```ini
   DECODO_USERNAME=user-yourname
   DECODO_PASSWORD=your-proxy-password
   DECODO_ENDPOINT=gate.decodo.com:7000    # 7000 rotates per request
   DECODO_COUNTRY=us                        # default country, optional
   DECODO_SESSION_MINUTES=10                # default sticky lifetime
   ```

4. Restart the engine, then open **Settings → Proxy → Test connection**. It
   routes one request through the proxy and reports the exit IP, country, city
   and network — or the exact reason it failed (missing key, HTTP 407, refused
   connection).
5. In the job wizard, choose **Fetch → Proxy → Decodo residential**.

Targeting is expressed in the job (`decodo://?country=us&city=new_york&session=…&sticky=10`),
and the engine expands it into Decodo's documented username format at fetch
time. The same policy applies to HTTP fetches and to headless-Chromium renders.
Self-hosted proxies are still supported with `kind: 'custom'`; the UI warns that
those URLs store their own credentials in the job.

## Project structure

```
apps/web/            Next.js 16 dashboard + BFF API routes (App Router, Tailwind v4)
  src/app/(app)/       Dashboard · Jobs · Data · Settings
  src/app/api/         REST API: jobs, runs, records, exports, keys, webhooks, cron, proxy
  src/lib/             env, store (demo | Supabase), engine client, schedule, crypto, rate limits
apps/worker/         Node.js BullMQ consumers (scrape, schedule, deliver, ai)
services/engine/     FastAPI + httpx + selectolax/trafilatura + Playwright
  app/fetch/           hardened HTTP fetcher, browser fetcher, proxy resolution
  app/core/            SSRF guard, robots.txt, rate limits, retry policy
  app/extract/         structured-data, heuristic and selector-based extraction
packages/shared/     The contract: ScrapeConfig (Zod), cron, webhooks, proxies, errors
supabase/migrations/ Postgres schema, RLS policies, RPC functions
docs/                ARCHITECTURE.md · IMPLEMENTATION_PLAN.md · SECURITY.md
```

## Feature tour

- **Dashboard** — run health, record growth, recent activity, engine status.
- **Job wizard** — targets, crawl scope, rendering, extraction, proxy and
  schedule, with a live extraction preview before you commit.
- **Crawl** — same-domain BFS with depth/page limits, include/exclude globs,
  robots.txt by default, per-domain rate limiting, polite delays.
- **Extraction** — JSON-LD/Open Graph, structural record detection, explicit
  CSS/XPath selectors, or an LLM for the awkward cases.
- **Data explorer** — search, filter by job, changed-only view, CSV/JSONL export.
- **Scheduling** — cron with real time-zone arithmetic, catch-up-safe dispatch.
- **Webhooks** — HMAC-SHA256 signed, timestamped, retried with backoff, with a
  delivery ledger.
- **API keys** — scoped, peppered-hash storage, shown once, revocable.
- **Dark mode** — light/dark/system, no flash of the wrong theme.

## How it fits together

```
Browser ──► Next.js (UI + API)  ──► FastAPI engine ──► target sites
                 │                        ▲
                 └──► Redis/BullMQ ──► Worker ┘
                 └──► Supabase (Postgres, Auth, Storage) or a local JSON store
```

Every job is one declarative, versioned `ScrapeConfig` document, validated by
the **same rules** on both sides — Zod in TypeScript, Pydantic in Python. A
config that passes in the wizard cannot fail differently in the engine.

## Going to production

| Capability | Turn it on with |
| --- | --- |
| Multi-tenant Postgres + Auth + RLS | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; then `supabase db push` |
| Durable queues (survive restarts) | `REDIS_URL` + `npm run dev:worker` |
| AI extraction & enrichment | `AI_BASE_URL`, `AI_API_KEY` (any OpenAI-compatible endpoint, including local Ollama) |
| JavaScript-rendered pages | `ENGINE_ENABLE_BROWSER=true` + `python -m playwright install chromium` |
| Scheduled runs | `CRON_SECRET` + a scheduler hitting `POST /api/cron` every minute |

## Security posture

- **SSRF guard** on every hop, including in-browser sub-requests and redirects;
  DNS answers are pinned to the connection to close the rebinding window.
- **robots.txt respected by default**, with a per-job override that is recorded.
- **Row-Level Security on by default**; the service-role key never reaches a browser.
- **Webhooks** are signed, timestamped, replay-windowed, redirect-refusing and
  validated against a URL policy before anything is sent.
- **Prompt-injection defence** for scraped content that reaches an LLM.
- Secrets are redacted in logs, including credentials embedded in proxy URLs.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model and the
reasoning behind each control.

## Honest status

- The engine has a full suite (270 tests); the shared contract and worker have
  41 unit tests; `next build` compiles every page and route.
- Supabase migrations (`supabase/migrations/0001–0003`) are written but have not
  been executed against a live database from this checkout.
- The worker has no demo mode by design — it needs Supabase and Redis.
- Live fetching requires outbound network access from wherever the engine runs.

## Licence

MIT
