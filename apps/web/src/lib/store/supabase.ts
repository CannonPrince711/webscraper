import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  errors,
  type ApiKey,
  type CreateJobInput,
  type DashboardStats,
  type Job,
  type JobRun,
  type OrgContext,
  type OrgRole,
  type Paginated,
  type PageRow,
  type RecordQuery,
  type RecordRow,
  type RunLogEntry,
  type UpdateJobInput,
  type UsageEvent,
  type UsageKind,
  type Webhook,
} from '@webscraper/shared';
import { logger } from '../logger';
import { createSupabaseAdminClient } from '../supabase/admin';
import { createSupabaseServerClient } from '../supabase/server';
import { QUERY_LIMITS, type Store } from './types';

/**
 * The production store: Postgres via Supabase, with the caller's identity.
 *
 * Every query runs through the **anon** client, so Row Level Security is the
 * authority on what this user may see. The `org_id` filters below are there to
 * use the right index, not to provide security — if a filter were ever wrong,
 * RLS still returns zero rows rather than another tenant's data.
 */
export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;

  constructor(private readonly client: SupabaseClient) {}

  private async requireOrgId(): Promise<string> {
    const context = await this.getOrgContext();
    return context.org.id;
  }

  async getOrgContext(): Promise<OrgContext> {
    const {
      data: { user },
      error: authError,
    } = await this.client.auth.getUser();

    if (authError || !user) throw errors.unauthorized();

    const { data: membership, error } = await this.client
      .from('org_members')
      .select('org_id, role, organizations(*)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error('Failed to load organisation membership', { code: error.code });
      throw errors.internal(`membership query failed: ${error.code}`);
    }

    const org = (membership as { organizations?: unknown } | null)?.organizations;
    if (!membership || !org) {
      // The signup trigger creates a personal org. Reaching this means it did
      // not run, which is worth surfacing precisely rather than as a 500.
      throw errors.internal(
        'no organisation membership found for user',
        'Your account has no workspace. Sign out and back in, or contact support.',
      );
    }

    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;

    return {
      user: {
        id: user.id,
        email: user.email ?? null,
        fullName: (metadata.full_name as string | undefined) ?? null,
        avatarUrl: (metadata.avatar_url as string | undefined) ?? null,
      },
      org: org as OrgContext['org'],
      role: ((membership as { role?: string }).role ?? 'viewer') as OrgRole,
      demo: false,
    };
  }

  // --- jobs ---------------------------------------------------------
  async listJobs(options: { limit?: number; status?: string } = {}): Promise<Job[]> {
    const orgId = await this.requireOrgId();
    let query = this.client
      .from('jobs')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(Math.min(options.limit ?? QUERY_LIMITS.jobs, QUERY_LIMITS.jobs));

    if (options.status) query = query.eq('status', options.status);

    const { data, error } = await query;
    if (error) throw errors.internal(`listJobs: ${error.code}`);
    return (data ?? []) as Job[];
  }

  async getJob(id: string): Promise<Job | null> {
    const { data, error } = await this.client.from('jobs').select('*').eq('id', id).maybeSingle();
    if (error) throw errors.internal(`getJob: ${error.code}`);
    return (data as Job | null) ?? null;
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    const orgId = await this.requireOrgId();
    const {
      data: { user },
    } = await this.client.auth.getUser();

    const { data, error } = await this.client
      .from('jobs')
      .insert({
        org_id: orgId,
        project_id: input.projectId ?? null,
        name: input.name,
        mode: input.mode,
        status: 'draft',
        config: input.config,
        schedule_cron: input.scheduleCron ?? null,
        schedule_enabled: input.scheduleEnabled ?? false,
        tags: input.tags ?? [],
        created_by: user?.id ?? null,
      })
      .select('*')
      .single();

    if (error || !data) throw errors.internal(`createJob: ${error?.code}`);
    return data as Job;
  }

  async updateJob(id: string, input: UpdateJobInput): Promise<Job> {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.config !== undefined) patch.config = input.config;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.status !== undefined) patch.status = input.status;
    if (input.scheduleCron !== undefined) patch.schedule_cron = input.scheduleCron;
    if (input.scheduleEnabled !== undefined) patch.schedule_enabled = input.scheduleEnabled;

    const { data, error } = await this.client.from('jobs').update(patch).eq('id', id).select('*').single();
    if (error || !data) throw errors.internal(`updateJob: ${error?.code}`);
    return data as Job;
  }

  async deleteJob(id: string): Promise<void> {
    const { error } = await this.client.from('jobs').delete().eq('id', id);
    if (error) throw errors.internal(`deleteJob: ${error.code}`);
  }

  // --- scheduling ---------------------------------------------------
  async updateJobSchedule(
    id: string,
    input: { cron: string | null; tz: string; enabled: boolean; nextRunAt: string | null },
  ): Promise<Job> {
    const { data, error } = await this.client
      .from('jobs')
      .update({
        schedule_cron: input.cron,
        schedule_tz: input.tz,
        schedule_enabled: input.enabled && Boolean(input.cron),
        next_run_at: input.enabled && input.cron ? input.nextRunAt : null,
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error || !data) throw errors.internal(`updateJobSchedule: ${error?.code}`);
    return data as Job;
  }

  async listDueJobs(
    limit = 50,
  ): Promise<Array<{ id: string; name: string; orgId: string; cron: string; tz: string; nextRunAt: string | null }>> {
    // The view carries RLS through to `jobs` (security_invoker), so in a user
    // session this returns the caller's org only; the service-role client sees
    // every tenant, which is what the cron tick needs.
    const { data, error } = await this.client
      .from('due_scheduled_jobs')
      .select('id, name, schedule_cron, schedule_tz, next_run_at, org_id')
      .limit(limit);
    if (error) throw errors.internal(`listDueJobs: ${error.code}`);
    return (data ?? []).map((row) => {
      const record = row as {
        id: string;
        name: string;
        org_id: string;
        schedule_cron: string;
        schedule_tz: string;
        next_run_at: string | null;
      };
      return {
        id: record.id,
        name: record.name,
        orgId: record.org_id,
        cron: record.schedule_cron,
        tz: record.schedule_tz,
        nextRunAt: record.next_run_at,
      };
    });
  }

  // --- runs ---------------------------------------------------------
  async listRuns(jobId: string, limit = QUERY_LIMITS.runs): Promise<JobRun[]> {
    const { data, error } = await this.client
      .from('job_runs')
      .select('*')
      .eq('job_id', jobId)
      .order('run_number', { ascending: false })
      .limit(limit);
    if (error) throw errors.internal(`listRuns: ${error.code}`);
    return (data ?? []) as JobRun[];
  }

  async listRecentRuns(limit = 20): Promise<JobRun[]> {
    const orgId = await this.requireOrgId();
    const { data, error } = await this.client
      .from('job_runs')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw errors.internal(`listRecentRuns: ${error.code}`);
    return (data ?? []) as JobRun[];
  }

  async getRun(id: string): Promise<JobRun | null> {
    const { data, error } = await this.client.from('job_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw errors.internal(`getRun: ${error.code}`);
    return (data as JobRun | null) ?? null;
  }

  async createRun(jobId: string, trigger: JobRun['trigger']): Promise<JobRun> {
    const {
      data: { user },
    } = await this.client.auth.getUser();

    // run_number is assigned by a SECURITY DEFINER function under an advisory
    // lock, so two concurrent triggers cannot collide on the same number.
    const { data, error } = await this.client.rpc('create_job_run', {
      p_job_id: jobId,
      p_trigger: trigger,
      p_triggered_by: user?.id ?? null,
    });
    if (error || !data) throw errors.internal(`createRun: ${error?.code}`);

    const run = await this.getRun(data as string);
    if (!run) throw errors.internal('createRun: run vanished after creation');
    return run;
  }

  async updateRun(id: string, patch: Partial<JobRun>): Promise<JobRun> {
    const allowed = [
      'status', 'started_at', 'finished_at', 'duration_ms',
      'pages_ok', 'pages_failed', 'pages_total',
      'records_count', 'records_new', 'records_changed',
      'bytes_downloaded', 'ai_tokens_used', 'ai_cost_usd',
      'log', 'error_code', 'error_message',
    ] as const;

    const safePatch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (patch[key] !== undefined) safePatch[key] = patch[key];
    }

    const { data, error } = await this.client.from('job_runs').update(safePatch).eq('id', id).select('*').single();
    if (error || !data) throw errors.internal(`updateRun: ${error?.code}`);
    return data as JobRun;
  }

  async deleteRun(id: string): Promise<void> {
    // `pages.run_id` is `on delete cascade`; `records.run_id` is
    // `on delete set null`. The database enforces the same policy as the demo
    // store, so behaviour does not change when you add credentials.
    const { error } = await this.client.from('job_runs').delete().eq('id', id);
    if (error) throw errors.internal(`deleteRun: ${error.code}`);
  }

  async appendRunLog(id: string, entry: RunLogEntry): Promise<void> {
    // Server-side append with a cap, so a chatty crawl cannot bloat the row.
    const { error } = await this.client.rpc('append_run_log', { p_run_id: id, p_entry: entry, p_max_entries: 200 });
    if (error) logger.warn('appendRunLog failed', { code: error.code });
  }

  // --- data ---------------------------------------------------------
  async listPages(jobId: string, limit = QUERY_LIMITS.pages): Promise<PageRow[]> {
    const { data, error } = await this.client
      .from('pages')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw errors.internal(`listPages: ${error.code}`);
    return (data ?? []) as PageRow[];
  }

  async listRecords(query: RecordQuery): Promise<Paginated<RecordRow>> {
    const orgId = await this.requireOrgId();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(query.pageSize ?? QUERY_LIMITS.recordsPageSize, QUERY_LIMITS.recordsMaxPageSize);
    const from = (page - 1) * pageSize;

    let builder = this.client
      .from('records')
      .select('*', { count: 'exact' })
      .eq('org_id', orgId)
      .range(from, from + pageSize - 1);

    if (query.jobId) builder = builder.eq('job_id', query.jobId);
    if (query.changedOnly) builder = builder.eq('is_changed', true);
    if (query.search) {
      // Free-text search across the JSON payload. Uses the pg_trgm/GIN indexes;
      // for very large tables a dedicated search view is the next step.
      builder = builder.textSearch('data', query.search, { type: 'plain', config: 'english' });
    }

    builder =
      query.sort === 'oldest'
        ? builder.order('created_at', { ascending: true })
        : query.sort === 'position'
          ? builder.order('position', { ascending: true })
          : builder.order('created_at', { ascending: false });

    const { data, error, count } = await builder;
    if (error) throw errors.internal(`listRecords: ${error.code}`);

    return {
      items: (data ?? []) as RecordRow[],
      total: count ?? 0,
      page,
      pageSize,
      hasMore: from + pageSize < (count ?? 0),
    };
  }

  async upsertRecords(
    rows: Array<Omit<RecordRow, 'id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at'>>,
  ): Promise<{ inserted: number; updated: number; changed: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0, changed: 0 };

    // The unique index on (job_id, content_hash) makes this an idempotent
    // re-run: seeing the same data again updates last_seen_at instead of
    // inserting a duplicate.
    const { data, error } = await this.client
      .from('records')
      .upsert(rows, { onConflict: 'job_id,content_hash', ignoreDuplicates: false, count: 'exact' })
      .select('id, is_changed');

    if (error) throw errors.internal(`upsertRecords: ${error.code}`);

    const changed = (data ?? []).filter((row) => (row as { is_changed?: boolean }).is_changed).length;
    return { inserted: data?.length ?? 0, updated: 0, changed };
  }

  async insertPages(rows: Array<Omit<PageRow, 'id' | 'created_at'>>): Promise<PageRow[]> {
    if (rows.length === 0) return [];
    const { data, error } = await this.client.from('pages').insert(rows).select('*');
    if (error) throw errors.internal(`insertPages: ${error.code}`);
    return (data ?? []) as PageRow[];
  }

  // --- dashboard ----------------------------------------------------
  async dashboardStats(): Promise<DashboardStats> {
    const orgId = await this.requireOrgId();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [jobsResult, recordsResult, runsTodayResult, recentRunsResult] = await Promise.all([
      this.client.from('jobs').select('id, status, schedule_enabled', { count: 'exact' }).eq('org_id', orgId),
      this.client.from('records').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
      this.client
        .from('job_runs')
        .select('id, status, records_new, pages_total')
        .eq('org_id', orgId)
        .gte('created_at', todayStart.toISOString()),
      this.client
        .from('job_runs')
        .select('id, status, records_count, pages_total, duration_ms, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);

    const jobs = (jobsResult.data ?? []) as Array<{ status: string; schedule_enabled: boolean }>;
    const runsToday = (runsTodayResult.data ?? []) as Array<{ status: string; records_new: number; pages_total: number }>;
    const recentRuns = (recentRunsResult.data ?? []) as Array<{
      status: string;
      records_count: number;
      pages_total: number;
      duration_ms: number | null;
      created_at: string;
    }>;

    const completed = recentRuns.filter((run) => run.status === 'succeeded' || run.status === 'partial');

    const byDay = new Map<string, { records: number; pages: number }>();
    for (let offset = 13; offset >= 0; offset -= 1) {
      byDay.set(new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10), { records: 0, pages: 0 });
    }
    for (const run of recentRuns) {
      const key = run.created_at.slice(0, 10);
      const bucket = byDay.get(key);
      if (bucket) {
        bucket.records += run.records_count;
        bucket.pages += run.pages_total;
      }
    }

    return {
      totalJobs: jobsResult.count ?? jobs.length,
      activeJobs: jobs.filter((job) => job.status === 'running' || job.status === 'queued' || job.schedule_enabled).length,
      totalRecords: recordsResult.count ?? 0,
      recordsToday: runsToday.reduce((sum, run) => sum + run.records_new, 0),
      runsToday: runsToday.length,
      failedToday: runsToday.filter((run) => run.status === 'failed' || run.status === 'partial').length,
      pagesToday: runsToday.reduce((sum, run) => sum + run.pages_total, 0),
      successRate: recentRuns.length === 0 ? 1 : completed.length / recentRuns.length,
      avgDurationMs: completed.length === 0 ? 0 : Math.round(completed.reduce((sum, run) => sum + (run.duration_ms ?? 0), 0) / completed.length),
      throughput: Array.from(byDay.entries()).map(([date, value]) => ({ date, ...value })),
    };
  }

  // --- credentials --------------------------------------------------
  async listApiKeys(): Promise<ApiKey[]> {
    const orgId = await this.requireOrgId();
    const { data, error } = await this.client
      .from('api_keys')
      .select('id, org_id, name, prefix, scopes, last_used_at, request_count, expires_at, revoked_at, created_by, created_at')
      .eq('org_id', orgId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error) throw errors.internal(`listApiKeys: ${error.code}`);
    return (data ?? []) as ApiKey[];
  }

  async createApiKey(input: { name: string; scopes: string[]; hash: string; prefix: string; expiresAt?: string | null }): Promise<ApiKey> {
    const orgId = await this.requireOrgId();
    const {
      data: { user },
    } = await this.client.auth.getUser();

    const { data, error } = await this.client
      .from('api_keys')
      .insert({
        org_id: orgId,
        name: input.name,
        key_hash: input.hash,
        prefix: input.prefix,
        scopes: input.scopes,
        expires_at: input.expiresAt ?? null,
        created_by: user?.id ?? null,
      })
      .select('id, org_id, name, prefix, scopes, last_used_at, request_count, expires_at, revoked_at, created_by, created_at')
      .single();

    if (error || !data) throw errors.internal(`createApiKey: ${error?.code}`);
    return data as ApiKey;
  }

  async revokeApiKey(id: string): Promise<void> {
    const { error } = await this.client.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) throw errors.internal(`revokeApiKey: ${error.code}`);
  }

  /**
   * The signing secret is excluded from every column grant to `authenticated`,
   * so this returns empty by design. Delivery happens in the worker using the
   * service-role client, which is the only reader of `signing_secret`.
   */
  async listWebhookSecrets(): Promise<Array<{ id: string; url: string; events: string[]; secret: string }>> {
    return [];
  }

  async listWebhooks(): Promise<Webhook[]> {
    const orgId = await this.requireOrgId();
    const { data, error } = await this.client
      .from('webhooks')
      .select('id, org_id, url, description, events, is_active, created_at, updated_at')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) throw errors.internal(`listWebhooks: ${error.code}`);
    return (data ?? []) as Webhook[];
  }

  async createWebhook(input: { url: string; description?: string | null; events: string[]; secret: string }): Promise<Webhook> {
    const orgId = await this.requireOrgId();
    const {
      data: { user },
    } = await this.client.auth.getUser();

    const { data, error } = await this.client
      .from('webhooks')
      .insert({
        org_id: orgId,
        url: input.url,
        description: input.description ?? null,
        events: input.events,
        signing_secret: input.secret,
        created_by: user?.id ?? null,
      })
      .select('id, org_id, url, description, events, is_active, created_at, updated_at')
      .single();

    if (error || !data) throw errors.internal(`createWebhook: ${error?.code}`);
    return data as Webhook;
  }

  /**
   * Update a webhook.
   *
   * `secret` is special: `signing_secret` is excluded from the column grants to
   * `authenticated`, so rotating it cannot go through the RLS client at all.
   * It is done with the service-role client — a deliberate, narrow exception
   * that exists precisely so the secret never has to be readable by a user
   * session.
   */
  async updateWebhook(
    id: string,
    patch: { url?: string; description?: string | null; events?: string[]; isActive?: boolean; secret?: string },
  ): Promise<Webhook> {
    const columns = 'id, org_id, url, description, events, is_active, created_at, updated_at';

    const row: Record<string, unknown> = {};
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.events !== undefined) row.events = patch.events;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;

    if (patch.secret !== undefined) {
      const admin = createSupabaseAdminClient();
      if (!admin) {
        throw errors.forbidden(
          'Rotating a webhook signing secret needs SUPABASE_SERVICE_ROLE_KEY, which is not configured on this deployment.',
        );
      }
      const { error } = await admin.from('webhooks').update({ signing_secret: patch.secret }).eq('id', id);
      if (error) throw errors.internal(`updateWebhook(secret): ${error.code}`);
    }

    if (Object.keys(row).length === 0) {
      const { data, error } = await this.client.from('webhooks').select(columns).eq('id', id).single();
      if (error || !data) throw errors.notFound('Webhook');
      return data as Webhook;
    }

    const { data, error } = await this.client.from('webhooks').update(row).eq('id', id).select(columns).single();
    if (error || !data) throw errors.internal(`updateWebhook: ${error?.code}`);
    return data as Webhook;
  }

  async deleteWebhook(id: string): Promise<void> {
    const { error } = await this.client.from('webhooks').update({ is_active: false }).eq('id', id);
    if (error) throw errors.internal(`deleteWebhook: ${error.code}`);
  }

  // --- metering -----------------------------------------------------
  async recordUsage(input: {
    kind: UsageKind;
    quantity: number;
    unitCostUsd?: number;
    jobId?: string | null;
    runId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const orgId = await this.requireOrgId();
    const { error } = await this.client.from('usage_events').insert({
      org_id: orgId,
      kind: input.kind,
      quantity: input.quantity,
      unit_cost_usd: input.unitCostUsd ?? 0,
      job_id: input.jobId ?? null,
      run_id: input.runId ?? null,
      metadata: input.metadata ?? {},
    });
    // Metering must never break a scrape; log and move on.
    if (error) logger.warn('recordUsage failed', { code: error.code });
  }

  async listUsage(days: number): Promise<UsageEvent[]> {
    const orgId = await this.requireOrgId();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error } = await this.client
      .from('usage_events')
      .select('*')
      .eq('org_id', orgId)
      .gte('occurred_at', cutoff)
      .order('occurred_at', { ascending: false })
      .limit(2000);
    if (error) throw errors.internal(`listUsage: ${error.code}`);
    return (data ?? []) as UsageEvent[];
  }

  async aiTokensThisMonth(): Promise<number> {
    const orgId = await this.requireOrgId();
    const { data, error } = await this.client.rpc('org_ai_tokens_this_month', { p_org_id: orgId });
    if (error) {
      logger.warn('aiTokensThisMonth failed', { code: error.code });
      return 0;
    }
    return Number(data ?? 0);
  }
}

export async function createSupabaseStore(): Promise<SupabaseStore> {
  const client = await createSupabaseServerClient();
  if (!client) throw errors.internal('Supabase is not configured');
  return new SupabaseStore(client);
}
