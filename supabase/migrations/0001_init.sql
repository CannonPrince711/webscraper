-- ============================================================================
--  0001_init.sql — core schema
--  Tenancy model: every row belongs to an `org_id`. RLS (0002) enforces that a
--  user may only touch rows of orgs they are a member of.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";
create extension if not exists "pg_trgm";
create extension if not exists "btree_gin";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type org_role as enum ('owner', 'admin', 'member', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_mode as enum ('single', 'crawl', 'sitemap', 'batch');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum ('draft', 'queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'paused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type run_status as enum ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'timeout');
exception when duplicate_object then null; end $$;

do $$ begin
  create type run_trigger as enum ('manual', 'schedule', 'api', 'webhook', 'retry');
exception when duplicate_object then null; end $$;

do $$ begin
  create type page_status as enum ('fetched', 'rendered', 'not_modified', 'http_error', 'blocked_robots', 'blocked_ssrf', 'timeout', 'too_large', 'skipped', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type extract_strategy as enum ('auto', 'selectors', 'llm', 'recipe');
exception when duplicate_object then null; end $$;

do $$ begin
  create type delivery_status as enum ('pending', 'delivered', 'failed', 'dead');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       citext,
  full_name   text,
  avatar_url  text,
  theme       text not null default 'system' check (theme in ('light', 'dark', 'system')),
  onboarded_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  slug        citext not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  plan        text not null default 'free' check (plan in ('free', 'starter', 'pro', 'scale', 'enterprise')),
  -- Hard ceilings enforced in the worker; kept here so support can raise them per tenant.
  limits      jsonb not null default jsonb_build_object(
                'maxPagesPerJob', 5000,
                'maxCrawlDepth', 6,
                'requestsPerMinute', 600,
                'aiTokensPerMonth', 2000000,
                'retentionDays', 30
              ),
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        org_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members (user_id);

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  email       citext not null,
  role        org_role not null default 'member',
  token_hash  text not null unique,
  invited_by  uuid references auth.users (id) on delete set null,
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invitations_org_idx on public.invitations (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Projects & reusable recipes
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 120),
  description    text,
  -- Default ScrapeConfig merged into every job created in this project.
  default_config jsonb not null default '{}'::jsonb,
  retention_days int not null default 30 check (retention_days between 0 and 3650),
  archived_at    timestamptz,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists projects_org_idx on public.projects (org_id, created_at desc);

create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations (id) on delete cascade, -- null => public recipe
  project_id  uuid references public.projects (id) on delete set null,
  name        text not null,
  description text,
  domain      citext,
  config      jsonb not null,
  is_public   boolean not null default false,
  usage_count int not null default 0,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists recipes_lookup_idx on public.recipes (domain, is_public);

-- ---------------------------------------------------------------------------
-- Jobs, runs, pages, records
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  project_id      uuid references public.projects (id) on delete set null,
  name            text not null check (char_length(name) between 1 and 200),
  mode            job_mode not null default 'single',
  status          job_status not null default 'draft',
  config          jsonb not null,                       -- validated ScrapeConfig v1
  -- Scheduling
  schedule_cron   text,                                 -- e.g. '0 */6 * * *'
  schedule_tz     text not null default 'UTC',
  schedule_enabled boolean not null default false,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  tags            text[] not null default '{}',
  run_count       int not null default 0,
  record_count    bigint not null default 0,
  -- Populated by the worker after each run; drives the dashboard without a join.
  stats           jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists jobs_org_created_idx on public.jobs (org_id, created_at desc);
create index if not exists jobs_org_status_idx  on public.jobs (org_id, status);
create index if not exists jobs_due_idx         on public.jobs (next_run_at) where schedule_enabled and status <> 'cancelled';
create index if not exists jobs_tags_idx        on public.jobs using gin (tags);

create table if not exists public.job_runs (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.jobs (id) on delete cascade,
  org_id            uuid not null references public.organizations (id) on delete cascade,
  run_number        int not null default 1,
  status            run_status not null default 'queued',
  trigger           run_trigger not null default 'manual',
  triggered_by      uuid references auth.users (id) on delete set null,
  started_at        timestamptz,
  finished_at       timestamptz,
  duration_ms       int,
  pages_ok          int not null default 0,
  pages_failed      int not null default 0,
  pages_total       int not null default 0,
  records_count     int not null default 0,
  records_new       int not null default 0,
  records_changed   int not null default 0,
  bytes_downloaded  bigint not null default 0,
  ai_tokens_used    int not null default 0,
  ai_cost_usd       numeric(10, 6) not null default 0,
  -- Rolling tail of structured log lines, capped by the worker (see 0003).
  log               jsonb not null default '[]'::jsonb,
  error_code        text,
  error_message     text,
  created_at        timestamptz not null default now()
);
create index if not exists job_runs_job_idx on public.job_runs (job_id, run_number desc);
create index if not exists job_runs_org_idx on public.job_runs (org_id, created_at desc);
create unique index if not exists job_runs_number_uniq on public.job_runs (job_id, run_number);

create table if not exists public.pages (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations (id) on delete cascade,
  job_id                   uuid not null references public.jobs (id) on delete cascade,
  run_id                   uuid references public.job_runs (id) on delete cascade,
  url                      text not null,
  url_hash                 text not null,                -- sha256(normalised url)
  canonical_url            text,
  status                   page_status not null default 'fetched',
  http_status              int,
  depth                    int not null default 0,
  content_type             text,
  content_hash             text,                         -- sha256(body) — drives change detection
  title                    text,
  lang                     text,
  bytes                    bigint,
  duration_ms              int,
  fetch_method             text,                         -- 'http' | 'browser'
  artifact_html_path       text,
  artifact_screenshot_path text,
  markdown                 text,
  metadata                 jsonb not null default '{}'::jsonb,  -- og:, twitter:, json-ld
  error_code               text,
  error_message            text,
  created_at               timestamptz not null default now()
);
create index if not exists pages_job_idx        on public.pages (job_id, created_at desc);
create index if not exists pages_run_idx        on public.pages (run_id);
create index if not exists pages_url_hash_idx   on public.pages (job_id, url_hash);
create index if not exists pages_status_idx     on public.pages (org_id, status);
create index if not exists pages_title_trgm_idx on public.pages using gin (title gin_trgm_ops);

create table if not exists public.records (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  job_id        uuid not null references public.jobs (id) on delete cascade,
  run_id        uuid references public.job_runs (id) on delete set null,
  page_id       uuid references public.pages (id) on delete cascade,
  position      int not null default 0,                  -- order within its page
  source_url    text,
  data          jsonb not null,                          -- deterministic extraction
  enriched      jsonb,                                   -- AI additions, never merged into `data`
  content_hash  text not null,                           -- sha256(canonical data) — dedupe key
  is_changed    boolean not null default false,
  previous_data jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- Re-seeing identical data updates last_seen_at instead of inserting a duplicate.
create unique index if not exists records_dedupe_uniq on public.records (job_id, content_hash);
create index if not exists records_job_idx    on public.records (job_id, created_at desc);
create index if not exists records_org_idx    on public.records (org_id, created_at desc);
create index if not exists records_page_idx   on public.records (page_id);
create index if not exists records_data_gin   on public.records using gin (data jsonb_path_ops);
create index if not exists records_changed_idx on public.records (org_id) where is_changed;

-- ---------------------------------------------------------------------------
-- Monitors (change tracking) & alerts
-- ---------------------------------------------------------------------------
create table if not exists public.monitors (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  job_id         uuid not null references public.jobs (id) on delete cascade,
  name           text not null,
  -- When any extracted record changes (or a selector stops matching), fire.
  watch_fields   text[] not null default '{}',
  mode           text not null default 'any_change' check (mode in ('any_change', 'field_change', 'appears', 'disappears', 'threshold')),
  field_path     text,
  comparator     text check (comparator in ('gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains')),
  threshold      numeric,
  -- e.g. [{"channel":"webhook","webhookId":"..."},{"channel":"email","to":"..."}]
  alert_channels jsonb not null default '[]'::jsonb,
  is_active      boolean not null default true,
  last_fired_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists monitors_job_idx on public.monitors (job_id) where is_active;

create table if not exists public.alert_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  monitor_id     uuid references public.monitors (id) on delete cascade,
  job_id         uuid references public.jobs (id) on delete cascade,
  run_id         uuid references public.job_runs (id) on delete set null,
  severity       text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title          text not null,
  body           text,
  payload        jsonb not null default '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists alert_events_org_idx on public.alert_events (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Credentials, egress & delivery
-- ---------------------------------------------------------------------------
create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  name          text not null,
  -- Display-only prefix so a user can identify a key ("ws_live_9f2c...").
  prefix        text not null,
  -- sha256(secret). The plaintext is shown exactly once, at creation.
  key_hash      text not null unique,
  scopes        text[] not null default '{jobs:read}',
  last_used_at  timestamptz,
  request_count bigint not null default 0,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists api_keys_org_idx on public.api_keys (org_id) where revoked_at is null;

create table if not exists public.proxies (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  label            text not null,
  kind             text not null default 'http' check (kind in ('http', 'https', 'socks5', 'residential', 'datacenter')),
  -- Credentials are encrypted at rest with pgcrypto using a key held by the app,
  -- never stored plaintext and never returned to the browser.
  endpoint_encrypted bytea not null,
  country          text,
  is_active        boolean not null default true,
  last_checked_at  timestamptz,
  last_error       text,
  success_count    bigint not null default 0,
  failure_count    bigint not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists proxies_org_idx on public.proxies (org_id) where is_active;

create table if not exists public.webhooks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  url         text not null check (url ~ '^https://'),
  description text,
  events      text[] not null default '{run.succeeded,run.failed}',
  -- HMAC signing secret. Unlike an API key this must be *reversible*: we have
  -- to reproduce the signature on every delivery, so a hash is useless here.
  -- It is encrypted at rest by the platform, excluded from every column grant
  -- to `authenticated`, and read only by the worker's service-role client.
  -- Receivers verify: X-Webscraper-Signature: t=<unix>,v1=<hex>.
  signing_secret text not null,
  is_active   boolean not null default true,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists webhooks_org_idx on public.webhooks (org_id) where is_active;

create table if not exists public.webhook_deliveries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  webhook_id    uuid not null references public.webhooks (id) on delete cascade,
  event         text not null,
  payload       jsonb not null,
  status        delivery_status not null default 'pending',
  attempts      int not null default 0,
  response_status int,
  response_snippet text,
  next_attempt_at timestamptz not null default now(),
  delivered_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists webhook_deliveries_retry_idx
  on public.webhook_deliveries (next_attempt_at) where status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- Metering & audit
-- ---------------------------------------------------------------------------
create table if not exists public.usage_events (
  id             bigserial primary key,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  kind           text not null check (kind in ('page_fetch', 'browser_render', 'ai_tokens', 'export', 'api_request')),
  quantity       numeric(14, 3) not null default 1,
  unit_cost_usd  numeric(12, 8) not null default 0,
  job_id         uuid references public.jobs (id) on delete set null,
  run_id         uuid references public.job_runs (id) on delete set null,
  metadata       jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now()
);
create index if not exists usage_events_org_time_idx on public.usage_events (org_id, occurred_at desc);
create index if not exists usage_events_kind_idx     on public.usage_events (org_id, kind, occurred_at desc);

create table if not exists public.audit_logs (
  id                bigserial primary key,
  org_id            uuid not null references public.organizations (id) on delete cascade,
  actor_user_id     uuid references auth.users (id) on delete set null,
  actor_api_key_id  uuid references public.api_keys (id) on delete set null,
  action            text not null,
  target_type       text,
  target_id         text,
  metadata          jsonb not null default '{}'::jsonb,
  ip                inet,
  user_agent        text,
  created_at        timestamptz not null default now()
);
create index if not exists audit_logs_org_idx on public.audit_logs (org_id, created_at desc);
