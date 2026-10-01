import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  errors,
  normalizeUrl,
  type Job,
  type JobRun,
  type Json,
  type PageRow,
  type RecordRow,
  type RunLogEntry,
  type UsageKind,
} from '@webscraper/shared';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Service-role data access for the worker.
 *
 * This is the one process in the system allowed to read and write across
 * tenants, because it processes work for all of them. Two rules keep that from
 * becoming a security problem:
 *
 *  1. **Every query is scoped by `org_id`** taken from the queue payload, not
 *     from anything a client sent. The service role would happily return every
 *     row otherwise.
 *  2. **Writes go through the same RPCs the app uses** (`create_job_run`,
 *     `append_run_log`, `finalize_job_run`), so run numbering, log trimming and
 *     the job roll-up have exactly one implementation.
 *
 * Signing secrets are read here and *only* here, which is why the column is
 * unreadable by the `authenticated` role.
 */

export const supabase: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-client-info': 'webscraper-worker' } },
});

function fail(operation: string, message?: string): never {
  throw errors.internal(`${operation}${message ? `: ${message}` : ''}`);
}

// ---------------------------------------------------------------------------
// Jobs and runs
// ---------------------------------------------------------------------------

export async function getJob(jobId: string): Promise<Job | null> {
  const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) fail('getJob', error.code);
  return (data as Job | null) ?? null;
}

export async function getRun(runId: string): Promise<JobRun | null> {
  const { data, error } = await supabase.from('job_runs').select('*').eq('id', runId).maybeSingle();
  if (error) fail('getRun', error.code);
  return (data as JobRun | null) ?? null;
}

/**
 * Create a run if the caller did not already create one.
 *
 * The web app creates the row before enqueueing so the user gets a run id
 * immediately; the scheduler also creates it up front. This is the safety net
 * for a retried queue job whose row was deleted mid-flight.
 */
export async function ensureRun(jobId: string, runId: string, trigger: JobRun['trigger']): Promise<string> {
  const existing = await getRun(runId);
  if (existing) return existing.id;

  const { data, error } = await supabase.rpc('create_job_run', {
    p_job_id: jobId,
    p_trigger: trigger,
    p_triggered_by: null,
  });
  if (error || !data) fail('ensureRun', error?.code);
  return data as string;
}

export async function updateRun(runId: string, patch: Partial<JobRun>): Promise<void> {
  const { error } = await supabase.from('job_runs').update(patch).eq('id', runId);
  if (error) fail('updateRun', error.code);
}

export async function appendLog(runId: string, entry: RunLogEntry, maxEntries = 200): Promise<void> {
  // Logging must never take a run down: a full disk or a schema drift here
  // would otherwise lose the crawl that was happily progressing.
  const { error } = await supabase.rpc('append_run_log', { p_run_id: runId, p_entry: entry, p_max_entries: maxEntries });
  if (error) logger.warn('Failed to append a run log entry', { runId, code: error.code });
}

export async function finalizeRun(
  runId: string,
  status: JobRun['status'],
  errorCode?: string | null,
  errorMessage?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('finalize_job_run', {
    p_run_id: runId,
    p_status: status,
    p_error_code: errorCode ?? null,
    p_error_message: errorMessage ? errorMessage.slice(0, 2000) : null,
  });
  if (error) fail('finalizeRun', error.code);
}

export async function isCancelled(runId: string): Promise<boolean> {
  const { data } = await supabase.from('job_runs').select('status').eq('id', runId).maybeSingle();
  return (data as { status?: string } | null)?.status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Pages and records
// ---------------------------------------------------------------------------

export async function insertPages(rows: Array<Omit<PageRow, 'id' | 'created_at'>>): Promise<PageRow[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase.from('pages').insert(rows).select('id, url, url_hash');
  if (error) fail('insertPages', error.code);
  return (data ?? []) as PageRow[];
}

export async function upsertRecords(
  rows: Array<Omit<RecordRow, 'id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at'>>,
): Promise<{ inserted: number; updated: number; changed: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, changed: 0 };

  const { data, error } = await supabase
    .from('records')
    .upsert(rows, { onConflict: 'job_id,content_hash', ignoreDuplicates: false, count: 'exact' })
    .select('id, is_changed');

  if (error) fail('upsertRecords', error.code);

  const changed = (data ?? []).filter((row) => (row as { is_changed?: boolean }).is_changed).length;
  return { inserted: data?.length ?? 0, updated: 0, changed };
}

/** The id of an existing page row for this run+URL, used to link records. */
export async function pageIdsForRun(runId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('pages').select('id, url, url_hash').eq('run_id', runId);
  if (error) fail('pageIdsForRun', error.code);

  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; url: string; url_hash: string | null }>) {
    map.set(normalizeUrl(row.url), row.id);
    if (row.url_hash) map.set(row.url_hash, row.id);
  }
  return map;
}

/**
 * Upload an artifact (HTML, screenshot) to the private `artifacts` bucket.
 *
 * Off by default: most deployments do not need a copy of every page's HTML, and
 * storing it is both a cost and a liability. When enabled, the object path is
 * `<org_id>/<job_id>/<run_id>/<name>` — the first segment is what the storage
 * policies key on, so a signed URL can never cross tenants.
 */
export async function uploadArtifact(
  path: string,
  body: string | Uint8Array,
  contentType: string,
): Promise<string | null> {
  if (!env.UPLOAD_ARTIFACTS) return null;

  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET_ARTIFACTS).upload(path, body, {
    contentType,
    upsert: true,
  });
  if (error) {
    logger.warn('Artifact upload failed', { code: error.name });
    return null;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Metering, schedules and webhooks
// ---------------------------------------------------------------------------

export async function recordUsage(input: {
  orgId: string;
  kind: UsageKind;
  quantity: number;
  unitCostUsd?: number;
  jobId?: string | null;
  runId?: string | null;
  metadata?: Record<string, Json>;
}): Promise<void> {
  const { error } = await supabase.from('usage_events').insert({
    org_id: input.orgId,
    kind: input.kind,
    quantity: input.quantity,
    unit_cost_usd: input.unitCostUsd ?? 0,
    job_id: input.jobId ?? null,
    run_id: input.runId ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) logger.warn('Usage write failed', { code: error.code });
}

export interface WebhookTarget {
  id: string;
  url: string;
  events: string[];
  secret: string;
}

/** Every active webhook for the org, secrets included. Service-role only. */
export async function webhookTargets(orgId: string): Promise<WebhookTarget[]> {
  const { data, error } = await supabase
    .from('webhooks')
    .select('id, url, events, signing_secret')
    .eq('org_id', orgId)
    .eq('is_active', true);

  if (error) {
    logger.warn('Could not read webhook targets', { code: error.code });
    return [];
  }

  return ((data ?? []) as Array<{ id: string; url: string; events: string[]; signing_secret: string }>).map((row) => ({
    id: row.id,
    url: row.url,
    events: row.events,
    secret: row.signing_secret,
  }));
}

export async function dueSchedules(limit = 50): Promise<
  Array<{ id: string; orgId: string; name: string; cron: string; tz: string }>
> {
  const { data, error } = await supabase
    .from('due_scheduled_jobs')
    .select('id, org_id, name, schedule_cron, schedule_tz')
    .limit(limit);

  if (error) fail('dueSchedules', error.code);

  return ((data ?? []) as Array<{ id: string; org_id: string; name: string; schedule_cron: string; schedule_tz: string }>).map(
    (row) => ({ id: row.id, orgId: row.org_id, name: row.name, cron: row.schedule_cron, tz: row.schedule_tz }),
  );
}

export async function setNextRun(jobId: string, nextRunAt: string | null): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({ next_run_at: nextRunAt, schedule_enabled: nextRunAt !== null })
    .eq('id', jobId);
  if (error) logger.warn('Could not advance a schedule', { jobId, code: error.code });
}

/** The ids of orgs with at least one active webhook, for cheap fan-out checks. */
export async function hasWebhooks(orgId: string): Promise<boolean> {
  const { count } = await supabase
    .from('webhooks')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('is_active', true);
  return (count ?? 0) > 0;
}
