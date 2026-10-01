import type {
  ApiKey,
  CreateJobInput,
  DashboardStats,
  Job,
  JobRun,
  OrgContext,
  Paginated,
  PageRow,
  RecordQuery,
  RecordRow,
  RunLogEntry,
  UpdateJobInput,
  UsageEvent,
  UsageKind,
  Webhook,
} from '@webscraper/shared';

/**
 * The persistence contract the whole app is written against.
 *
 * Two implementations exist: `supabase.ts` (Postgres + RLS, the real one) and
 * `demo.ts` (a local JSON file, so the repo runs with no credentials). Because
 * every page and route talks to this interface rather than to Supabase
 * directly, demo mode is a genuine working application instead of a stub —
 * and the swap is a single function call in `index.ts`.
 */
export interface Store {
  readonly kind: 'supabase' | 'demo';

  /** Who is calling, which org they act in, and with what role. */
  getOrgContext(): Promise<OrgContext>;

  // --- jobs ---------------------------------------------------------
  listJobs(options?: { limit?: number; status?: string }): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  createJob(input: CreateJobInput): Promise<Job>;
  updateJob(id: string, input: UpdateJobInput): Promise<Job>;
  deleteJob(id: string): Promise<void>;

  // --- runs ---------------------------------------------------------
  listRuns(jobId: string, limit?: number): Promise<JobRun[]>;
  listRecentRuns(limit?: number): Promise<JobRun[]>;
  getRun(id: string): Promise<JobRun | null>;
  createRun(jobId: string, trigger: JobRun['trigger']): Promise<JobRun>;
  updateRun(id: string, patch: Partial<JobRun>): Promise<JobRun>;
  appendRunLog(id: string, entry: RunLogEntry): Promise<void>;
  /** Delete a finished run. Its pages cascade; its records are kept, unlinked. */
  deleteRun(id: string): Promise<void>;

  // --- scheduling ---------------------------------------------------
  /**
   * Persist a job's schedule and the instant it should next fire.
   * `nextRunAt` is computed by the caller (see cron.ts in @webscraper/shared) so the tz maths
   * lives in one place instead of in SQL *and* in TypeScript.
   */
  updateJobSchedule(
    id: string,
    input: { cron: string | null; tz: string; enabled: boolean; nextRunAt: string | null },
  ): Promise<Job>;
  /** Scheduled jobs that are due to fire and are not already running. */
  listDueJobs(
    limit?: number,
  ): Promise<Array<{ id: string; name: string; orgId: string; cron: string; tz: string; nextRunAt: string | null }>>;

  // --- data ---------------------------------------------------------
  listPages(jobId: string, limit?: number): Promise<PageRow[]>;
  listRecords(query: RecordQuery): Promise<Paginated<RecordRow>>;
  upsertRecords(rows: Array<Omit<RecordRow, 'id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at'>>): Promise<{ inserted: number; updated: number; changed: number }>;
  /** Returns the created rows (with ids) so records can reference their page. */
  insertPages(rows: Array<Omit<PageRow, 'id' | 'created_at'>>): Promise<PageRow[]>;

  // --- dashboard ----------------------------------------------------
  dashboardStats(): Promise<DashboardStats>;

  // --- credentials and delivery -------------------------------------
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(input: { name: string; scopes: string[]; hash: string; prefix: string; expiresAt?: string | null }): Promise<ApiKey>;
  revokeApiKey(id: string): Promise<void>;

  listWebhooks(): Promise<Webhook[]>;
  createWebhook(input: { url: string; description?: string | null; events: string[]; secret: string }): Promise<Webhook>;
  /**
   * Signing secrets, resolvable only server-side. In Supabase mode this is
   * returned empty by the RLS-bound store; the service-role client is the only
   * reader (see lib/webhooks.ts).
   */
  listWebhookSecrets(): Promise<Array<{ id: string; url: string; events: string[]; secret: string }>>;
  updateWebhook(
    id: string,
    patch: { url?: string; description?: string | null; events?: string[]; isActive?: boolean; secret?: string },
  ): Promise<Webhook>;
  deleteWebhook(id: string): Promise<void>;

  // --- metering -----------------------------------------------------
  recordUsage(input: { kind: UsageKind; quantity: number; unitCostUsd?: number; jobId?: string | null; runId?: string | null; metadata?: Record<string, unknown> }): Promise<void>;
  listUsage(days: number): Promise<UsageEvent[]>;
  aiTokensThisMonth(): Promise<number>;
}

/** Row limits that keep an unbounded query from taking the app down. */
export const QUERY_LIMITS = {
  jobs: 200,
  runs: 100,
  pages: 500,
  recordsPageSize: 50,
  recordsMaxPageSize: 200,
} as const;
