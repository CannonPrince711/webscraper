/**
 * Shared domain types: database rows, API envelopes and engine payloads.
 *
 * Hand-maintained rather than generated from the Supabase CLI so the contract
 * is reviewable in a diff. `Json` mirrors Postgres `jsonb`.
 */
import { z } from 'zod';
import type { ScrapeConfig } from './scrape-config.js';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ---------------------------------------------------------------------------
// Enums (kept in sync with the Postgres enum types in 0001_init.sql)
// ---------------------------------------------------------------------------
export const JOB_STATUSES = ['draft', 'queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'paused'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'timeout'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['manual', 'schedule', 'api', 'webhook', 'retry'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const PAGE_STATUSES = [
  'fetched', 'rendered', 'not_modified', 'http_error', 'blocked_robots',
  'blocked_ssrf', 'timeout', 'too_large', 'skipped', 'error',
] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Runtime validators for the enum tuples above — one definition, two uses. */
export const jobStatusesSchema = z.enum(JOB_STATUSES);
export const runStatusesSchema = z.enum(RUN_STATUSES);
export const runTriggersSchema = z.enum(RUN_TRIGGERS);
export const pageStatusesSchema = z.enum(PAGE_STATUSES);
export const orgRolesSchema = z.enum(ORG_ROLES);

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';
export type UsageKind = 'page_fetch' | 'browser_render' | 'ai_tokens' | 'export' | 'api_request';

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------
export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  theme: 'light' | 'dark' | 'system';
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'starter' | 'pro' | 'scale' | 'enterprise';
  limits: OrgLimits;
  settings: Json;
  created_at: string;
  updated_at: string;
}

export interface OrgLimits {
  maxPagesPerJob: number;
  maxCrawlDepth: number;
  requestsPerMinute: number;
  aiTokensPerMonth: number;
  retentionDays: number;
}

export interface OrgMember {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  default_config: Json;
  retention_days: number;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  org_id: string;
  project_id: string | null;
  name: string;
  mode: 'single' | 'crawl' | 'sitemap' | 'batch';
  status: JobStatus;
  config: ScrapeConfig;
  schedule_cron: string | null;
  schedule_tz: string;
  schedule_enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  tags: string[];
  run_count: number;
  record_count: number;
  stats: JobStats;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobStats {
  lastRunId?: string;
  lastStatus?: RunStatus;
  lastDurationMs?: number;
  lastPagesOk?: number;
  lastRecordsNew?: number;
  lastRecordsChanged?: number;
  avgDurationMs?: number;
  successRate?: number;
  [key: string]: Json | undefined;
}

export interface JobRun {
  id: string;
  job_id: string;
  org_id: string;
  run_number: number;
  status: RunStatus;
  trigger: RunTrigger;
  triggered_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  pages_ok: number;
  pages_failed: number;
  pages_total: number;
  records_count: number;
  records_new: number;
  records_changed: number;
  bytes_downloaded: number;
  ai_tokens_used: number;
  ai_cost_usd: number;
  log: RunLogEntry[];
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface RunLogEntry {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  url?: string;
  meta?: Json;
}

export interface PageRow {
  id: string;
  org_id: string;
  job_id: string;
  run_id: string | null;
  url: string;
  url_hash: string;
  canonical_url: string | null;
  status: PageStatus;
  http_status: number | null;
  depth: number;
  content_type: string | null;
  content_hash: string | null;
  title: string | null;
  lang: string | null;
  bytes: number | null;
  duration_ms: number | null;
  fetch_method: string | null;
  artifact_html_path: string | null;
  artifact_screenshot_path: string | null;
  markdown: string | null;
  metadata: Json;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface RecordRow {
  id: string;
  org_id: string;
  job_id: string;
  run_id: string | null;
  page_id: string | null;
  position: number;
  source_url: string | null;
  data: Record<string, Json>;
  enriched: Record<string, Json> | null;
  content_hash: string;
  is_changed: boolean;
  previous_data: Record<string, Json> | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  org_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  request_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Webhook {
  id: string;
  org_id: string;
  url: string;
  description: string | null;
  events: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Monitor {
  id: string;
  org_id: string;
  job_id: string;
  name: string;
  watch_fields: string[];
  mode: 'any_change' | 'field_change' | 'appears' | 'disappears' | 'threshold';
  field_path: string | null;
  comparator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'contains' | null;
  threshold: number | null;
  alert_channels: AlertChannel[];
  is_active: boolean;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertChannel {
  channel: 'webhook' | 'email' | 'slack';
  webhookId?: string;
  to?: string;
  webhookUrl?: string;
}

export interface UsageEvent {
  id: number;
  org_id: string;
  kind: UsageKind;
  quantity: number;
  unit_cost_usd: number;
  job_id: string | null;
  run_id: string | null;
  metadata: Json;
  occurred_at: string;
}

// ---------------------------------------------------------------------------
// Engine payloads
// ---------------------------------------------------------------------------
export interface EngineStats {
  pagesTotal: number;
  pagesOk: number;
  pagesFailed: number;
  bytesTotal: number;
  recordsTotal: number;
  durationMs: number;
  browserRenders: number;
}

export interface EnginePageResult {
  url: string;
  finalUrl: string;
  status: PageStatus | 'ok' | 'not_modified';
  httpStatus: number | null;
  contentType: string | null;
  title: string | null;
  lang: string | null;
  canonicalUrl: string | null;
  contentHash: string | null;
  bodyBytes: number;
  durationMs: number;
  fetchMethod: 'http' | 'browser';
  rendered: boolean;
  depth: number;
  records: Array<Record<string, Json>>;
  recordConfidences: number[];
  markdown: string | null;
  text: string | null;
  html: string | null;
  metadata: Json;
  jsonLd: Json[];
  headings: Array<{ level: string; text: string }>;
  links: Array<{ url: string; normalizedUrl: string; text: string; rel: string[]; nofollow: boolean; isPagination: boolean }>;
  sitemaps: string[];
  screenshotPngB64: string | null;
  extraction: {
    strategy?: string;
    source?: string;
    suggestedConfig?: { listSelector: string | null; fields: ExtractFieldSuggestion[] };
    /**
     * Engine diagnostics (`strategy`, `source`, per-field match counts…).
     * Deliberately `unknown`: this is an open bag of engine-reported facts, and
     * typing it as `Json` would force the richer shape above to be JSON too.
     */
    [key: string]: unknown;
  };
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ExtractFieldSuggestion {
  name: string;
  selector: string;
  type: string;
  coverage?: number;
}

export interface EngineScrapeResponse {
  results: EnginePageResult[];
  stats: EngineStats;
  discovered: string[];
  warnings: string[];
}

export interface SelectorProbeResult {
  name: string;
  selector: string;
  selectorType: 'css' | 'xpath';
  attribute?: string | null;
  matches: number;
  samples: string[];
  error: string | null;
}

/**
 * Result of the engine's proxy self-test (`POST /v1/proxy/check`).
 *
 * `label` describes the policy; the resolved URL — which contains the provider
 * password — is never part of this contract.
 */
export interface EngineProxyCheck {
  ok: boolean;
  kind: string;
  label: string;
  configured: boolean;
  durationMs: number;
  endpoint?: string | null;
  exitIp?: string | null;
  country?: string | null;
  city?: string | null;
  isp?: string | null;
  error?: string | null;
  hint?: string | null;
}

export interface EngineHealth {
  status: 'ok' | 'degraded';
  version: string;
  browserAvailable: boolean;
  aiEnabled: boolean;
  redisAvailable: boolean;
  uptimeSeconds: number;
  checks: Record<string, Json>;
}

// ---------------------------------------------------------------------------
// API envelopes
// ---------------------------------------------------------------------------
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, Json>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface DashboardStats {
  totalJobs: number;
  activeJobs: number;
  totalRecords: number;
  recordsToday: number;
  runsToday: number;
  failedToday: number;
  pagesToday: number;
  successRate: number;
  avgDurationMs: number;
  throughput: Array<{ date: string; records: number; pages: number }>;
}

export interface OrgContext {
  user: { id: string; email: string | null; fullName: string | null; avatarUrl: string | null };
  org: Organization;
  role: OrgRole;
  /** True when Supabase is not configured and the app is running on the local store. */
  demo: boolean;
}

export interface CreateJobInput {
  name: string;
  mode: Job['mode'];
  config: ScrapeConfig;
  projectId?: string | null;
  tags?: string[];
  scheduleCron?: string | null;
  scheduleEnabled?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  config?: ScrapeConfig;
  tags?: string[];
  status?: JobStatus;
  scheduleCron?: string | null;
  scheduleEnabled?: boolean;
}

export interface RecordQuery {
  jobId?: string;
  search?: string;
  changedOnly?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'newest' | 'oldest' | 'position';
}
