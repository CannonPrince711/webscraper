import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEMO_ORG,
  DEMO_USER,
  type ApiKey,
  type CreateJobInput,
  type DashboardStats,
  type Job,
  type JobRun,
  type OrgContext,
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
import type { Json } from '@webscraper/shared';
import { logger } from '../logger';
import { QUERY_LIMITS, type Store } from './types';

/**
 * A local, single-tenant store backed by one JSON file.
 *
 * Purpose: a clone of this repository must produce a working, populated
 * application in one command, with no Supabase project, no Redis and no API
 * keys. It is **not** a production database and says so everywhere it is
 * visible — `OrgContext.demo` is true, and the UI shows a banner.
 *
 * Implementation notes:
 *  - The whole dataset is held in memory and flushed to disk on a short debounce,
 *    so a burst of writes during a crawl is one file write, not thousands.
 *  - Writes are serialised through a promise chain to avoid interleaved flushes.
 *  - Seeded on first run with realistic data so the dashboard is not empty.
 */

interface DemoData {
  version: 1;
  jobs: Job[];
  runs: JobRun[];
  pages: PageRow[];
  records: RecordRow[];
  apiKeys: ApiKey[];
  webhooks: Webhook[];
  /**
   * Signing secrets, keyed by webhook id.
   *
   * Kept out of the `Webhook` objects on purpose: `listWebhooks()` serialises
   * straight to the API response, so a secret stored as a property of that row
   * would be one careless spread away from leaking to the browser.
   */
  webhookSecrets: Record<string, string>;
  usage: UsageEvent[];
}

const DATA_DIR = process.env.DEMO_DATA_DIR ?? path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

let cache: DemoData | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let writeChain: Promise<void> = Promise.resolve();

function nowIso(): string {
  return new Date().toISOString();
}

/** A slightly older copy of a record, for the "changed" badge in the demo data. */
function previousSnapshot(data: Record<string, Json>): Record<string, Json> {
  const snapshot: Record<string, Json> = { ...data };
  const price = snapshot['price'];
  if (typeof price === 'number') snapshot['price'] = price - 2;
  return snapshot;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
function seedData(): DemoData {
  const orgId = DEMO_ORG.id;
  const userId = DEMO_USER.id;
  const now = Date.now();

  const makeJob = (
    index: number,
    name: string,
    mode: Job['mode'],
    targets: string[],
    extras: Partial<Job> = {},
  ): Job => {
    const created = new Date(now - (index + 1) * 86_400_000).toISOString();
    return {
      id: randomUUID(),
      org_id: orgId,
      project_id: null,
      name,
      mode,
      status: 'succeeded',
      config: {
        version: 1,
        targets,
        mode,
        crawl: { maxDepth: 2, maxPages: 100, sameDomain: true, include: [], exclude: [], useSitemap: true, followNofollow: false, delayMs: 0, concurrency: 4, revisit: false },
        fetch: { render: 'auto', waitFor: null, timeoutMs: 30_000, respectRobots: true, maxBytes: 5_000_000, headers: {}, userAgent: null, proxy: null, device: 'desktop', viewportWidth: 1440, viewportHeight: 900, screenshot: false, saveHtml: true, blockAssets: true, followRedirects: true, maxRedirects: 5, referer: null },
        extract: { strategy: 'auto', listSelector: null, fields: [], schema: null, maxRecords: 1000, dedupeBy: [], minConfidence: 0.35, instructions: null },
        ai: { enrich: [], model: null, temperature: null, labels: [], instructions: null, maxTokens: null },
        limits: { maxPages: 5000, maxBytesPerPage: 5_000_000, maxDurationMs: 3_600_000, maxAiTokens: 120_000 },
        meta: {},
      },
      schedule_cron: index === 0 ? '0 */6 * * *' : null,
      schedule_tz: 'UTC',
      schedule_enabled: index === 0,
      next_run_at: index === 0 ? new Date(now + 3_600_000).toISOString() : null,
      last_run_at: new Date(now - index * 3_600_000).toISOString(),
      tags: index === 0 ? ['pricing'] : index === 1 ? ['jobs'] : ['news'],
      run_count: 3 + index,
      record_count: 120 - index * 35,
      stats: {
        lastStatus: 'succeeded',
        successRate: 1,
        avgDurationMs: 4200 + index * 900,
      },
      created_by: userId,
      created_at: created,
      updated_at: created,
      ...extras,
    };
  };

  const jobs: Job[] = [
    makeJob(0, 'Competitor pricing watch', 'crawl', ['https://books.example.com/catalogue'], { status: 'succeeded' }),
    makeJob(1, 'Remote engineering jobs', 'crawl', ['https://jobs.example.org/search?q=engineer'], { status: 'succeeded' }),
    makeJob(2, 'Tech headline monitor', 'sitemap', ['https://news.example.net/sitemap.xml'], { status: 'partial' }),
  ];

  const runs: JobRun[] = [];
  const records: RecordRow[] = [];
  const pages: PageRow[] = [];

  jobs.forEach((job, jobIndex) => {
    for (let runIndex = 0; runIndex < 3; runIndex += 1) {
      const startedAt = new Date(now - (jobIndex * 3 + runIndex + 1) * 1_800_000);
      const duration = 3_000 + jobIndex * 900 + runIndex * 400;
      const failed = jobIndex === 2 && runIndex === 0;
      const recordsCount = 40 - runIndex * 5 - jobIndex * 3;

      runs.push({
        id: randomUUID(),
        job_id: job.id,
        org_id: orgId,
        run_number: 3 - runIndex,
        status: failed ? 'partial' : 'succeeded',
        trigger: runIndex === 2 ? 'schedule' : 'manual',
        triggered_by: userId,
        started_at: startedAt.toISOString(),
        finished_at: new Date(startedAt.getTime() + duration).toISOString(),
        duration_ms: duration,
        pages_ok: recordsCount + 4,
        pages_failed: failed ? 3 : 0,
        pages_total: recordsCount + (failed ? 7 : 4),
        records_count: recordsCount,
        records_new: runIndex === 0 ? recordsCount : Math.max(0, recordsCount - 35),
        records_changed: runIndex === 0 ? 0 : 3,
        bytes_downloaded: 480_000 + recordsCount * 12_000,
        ai_tokens_used: jobIndex === 2 ? 1_850 : 0,
        ai_cost_usd: jobIndex === 2 ? 0.0021 : 0,
        log: [
          { at: startedAt.toISOString(), level: 'info', stage: 'queue', message: `Run #${3 - runIndex} started` },
          { at: new Date(startedAt.getTime() + 220).toISOString(), level: 'info', stage: 'crawl', message: `Discovered ${recordsCount + 4} in-scope pages` },
          { at: new Date(startedAt.getTime() + duration * 0.5).toISOString(), level: 'info', stage: 'extract', message: `Extracted ${recordsCount} records (auto strategy)` },
          ...(failed
            ? [{ at: new Date(startedAt.getTime() + duration * 0.8).toISOString(), level: 'warn' as const, stage: 'fetch', message: '3 pages blocked by robots.txt', meta: { code: 'robots_disallowed' } }]
            : []),
          { at: new Date(startedAt.getTime() + duration).toISOString(), level: 'info', stage: 'done', message: failed ? 'Finished with warnings' : 'Run completed' },
        ],
        error_code: failed ? 'robots_disallowed' : null,
        error_message: failed ? '3 pages were disallowed by robots.txt' : null,
        created_at: startedAt.toISOString(),
      });
    }

    // A handful of representative records per job so the explorer has content.
    const sample = jobIndex === 0
      ? [
          { title: 'Designing Data-Intensive Applications', price: 42.99, currency: 'USD', brand: 'O’Reilly', availability: 'InStock', rating: 4.8 },
          { title: 'The Pragmatic Programmer', price: 39.5, currency: 'USD', brand: 'Addison-Wesley', availability: 'InStock', rating: 4.7 },
          { title: 'Refactoring', price: 47.25, currency: 'USD', brand: 'Addison-Wesley', availability: 'LowStock', rating: 4.6 },
          { title: 'Site Reliability Engineering', price: 0, currency: 'USD', brand: 'O’Reilly', availability: 'FreeOnline', rating: 4.9 },
        ]
      : jobIndex === 1
        ? [
            { title: 'Senior Backend Engineer', company: 'Northwind', location: 'Remote (EU)', employment_type: 'FULL_TIME', salary: 95_000 },
            { title: 'Platform Engineer', company: 'Contoso', location: 'Berlin, DE', employment_type: 'FULL_TIME', salary: 88_000 },
            { title: 'Data Engineer', company: 'Fabrikam', location: 'Remote (US)', employment_type: 'CONTRACT', salary: 110_000 },
          ]
        : [
            { title: 'Rust 1.90 released', published_at: '2026-09-28', section: 'engineering' },
            { title: 'Postgres 18 beta', published_at: '2026-09-27', section: 'databases' },
          ];

    const latestRun = runs.filter((run) => run.job_id === job.id)[0];
    sample.forEach((data, index) => {
      records.push({
        id: randomUUID(),
        org_id: orgId,
        job_id: job.id,
        run_id: latestRun?.id ?? null,
        page_id: null,
        position: index,
        source_url: job.config.targets[0] ?? null,
        data,
        enriched: jobIndex === 0 ? { summary: `A ${String(data.title).toLowerCase()} listing from the catalogue.` } : null,
        content_hash: `seed-${job.id.slice(0, 8)}-${index}`,
        is_changed: index === 1 && jobIndex !== 2,
        // Demonstrate change detection: the previous snapshot differs by one
        // field for the second record of the first job.
        previous_data: index === 1 && jobIndex !== 2 ? previousSnapshot(data) : null,
        first_seen_at: new Date(now - 86_400_000 * 3).toISOString(),
        last_seen_at: new Date(now - 3_600_000).toISOString(),
        created_at: new Date(now - 86_400_000 * 3).toISOString(),
        updated_at: latestRun?.finished_at ?? nowIso(),
      });
    });

    // One sample page per job for the pages tab.
    pages.push({
      id: randomUUID(),
      org_id: orgId,
      job_id: job.id,
      run_id: latestRun?.id ?? null,
      url: job.config.targets[0] ?? 'https://example.com',
      url_hash: `seed-page-${job.id.slice(0, 8)}`,
      canonical_url: null,
      status: jobIndex === 2 ? 'blocked_robots' : 'fetched',
      http_status: jobIndex === 2 ? 403 : 200,
      depth: 0,
      content_type: 'text/html',
      content_hash: 'seed-content-hash',
      title: job.name,
      lang: 'en',
      bytes: 128_400,
      duration_ms: 640,
      fetch_method: 'http',
      artifact_html_path: null,
      artifact_screenshot_path: null,
      markdown: `# ${job.name}\n\nSample captured content for the demo store.`,
      metadata: { site_name: 'Example', description: 'Seeded demo page' },
      error_code: jobIndex === 2 ? 'robots_disallowed' : null,
      error_message: jobIndex === 2 ? 'Disallowed by robots.txt' : null,
      created_at: latestRun?.created_at ?? nowIso(),
    });
  });

  const usage: UsageEvent[] = [];
  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    const day = new Date(now - dayOffset * 86_400_000);
    const pagesCount = 120 + Math.round(Math.sin(dayOffset) * 40) + dayOffset * 3;
    usage.push({
      id: dayOffset * 2 + 1,
      org_id: orgId,
      kind: 'page_fetch',
      quantity: pagesCount,
      unit_cost_usd: 0.00004,
      job_id: jobs[dayOffset % jobs.length]?.id ?? null,
      run_id: null,
      metadata: {},
      occurred_at: day.toISOString(),
    });
    if (dayOffset % 3 === 0) {
      usage.push({
        id: dayOffset * 2 + 2,
        org_id: orgId,
        kind: 'ai_tokens',
        quantity: 1200 + dayOffset * 90,
        unit_cost_usd: 0.0000006,
        job_id: jobs[dayOffset % jobs.length]?.id ?? null,
        run_id: null,
        metadata: {},
        occurred_at: day.toISOString(),
      });
    }
  }

  return { version: 1, jobs, runs, pages, records, apiKeys: [], webhooks: [], webhookSecrets: {}, usage };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
async function load(): Promise<DemoData> {
  if (cache) return cache;

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) as DemoData;
    if (parsed?.version === 1 && Array.isArray(parsed.jobs)) {
      // Forward-compatible read: a store written by an older build simply has
      // no webhooks yet.
      parsed.webhookSecrets ??= {};
      cache = parsed;
      return cache;
    }
    logger.warn('Demo store file is not a recognised version; reseeding');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('Could not read the demo store; starting from seed data', { code });
    }
  }

  cache = seedData();
  await persist();
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const snapshot = JSON.stringify(cache, null, 2);
  // Serialise flushes; a slow write must not interleave with the next one.
  writeChain = writeChain.then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(DATA_FILE, snapshot, 'utf8');
    } catch (error) {
      logger.error('Failed to persist the demo store', { error: (error as Error).message });
    }
  });
  return writeChain;
}

/** Debounced flush: a crawl writes thousands of rows, the disk sees a few writes. */
function schedulePersist(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void persist();
  }, 250);
}

function touch(): void {
  if (flushTimer) return;
  schedulePersist();
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------
export class DemoStore implements Store {
  readonly kind = 'demo' as const;

  async getOrgContext(): Promise<OrgContext> {
    return {
      user: { id: DEMO_USER.id, email: DEMO_USER.email, fullName: DEMO_USER.fullName, avatarUrl: null },
      org: {
        id: DEMO_ORG.id,
        name: DEMO_ORG.name,
        slug: DEMO_ORG.slug,
        plan: 'pro',
        limits: {
          maxPagesPerJob: 5000,
          maxCrawlDepth: 6,
          requestsPerMinute: 600,
          aiTokensPerMonth: 2_000_000,
          retentionDays: 30,
        },
        settings: {},
        created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        updated_at: nowIso(),
      },
      role: 'owner',
      demo: true,
    };
  }

  // --- jobs ---------------------------------------------------------
  async listJobs(options: { limit?: number; status?: string } = {}): Promise<Job[]> {
    const data = await load();
    const limit = Math.min(options.limit ?? QUERY_LIMITS.jobs, QUERY_LIMITS.jobs);
    return data.jobs
      .filter((job) => (options.status ? job.status === options.status : true))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  async getJob(id: string): Promise<Job | null> {
    const data = await load();
    return data.jobs.find((job) => job.id === id) ?? null;
  }

  async createJob(input: CreateJobInput): Promise<Job> {
    const data = await load();
    const timestamp = nowIso();
    const job: Job = {
      id: randomUUID(),
      org_id: DEMO_ORG.id,
      project_id: input.projectId ?? null,
      name: input.name,
      mode: input.mode,
      status: 'draft',
      config: input.config,
      schedule_cron: input.scheduleCron ?? null,
      schedule_tz: 'UTC',
      schedule_enabled: input.scheduleEnabled ?? false,
      next_run_at: null,
      last_run_at: null,
      tags: input.tags ?? [],
      run_count: 0,
      record_count: 0,
      stats: {},
      created_by: DEMO_USER.id,
      created_at: timestamp,
      updated_at: timestamp,
    };
    data.jobs.unshift(job);
    touch();
    return job;
  }

  async updateJob(id: string, input: UpdateJobInput): Promise<Job> {
    const data = await load();
    const job = data.jobs.find((item) => item.id === id);
    if (!job) throw new Error(`Job ${id} not found`);

    Object.assign(job, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.scheduleCron !== undefined ? { schedule_cron: input.scheduleCron } : {}),
      ...(input.scheduleEnabled !== undefined ? { schedule_enabled: input.scheduleEnabled } : {}),
      updated_at: nowIso(),
    });
    touch();
    return job;
  }

  async deleteJob(id: string): Promise<void> {
    const data = await load();
    data.jobs = data.jobs.filter((job) => job.id !== id);
    data.runs = data.runs.filter((run) => run.job_id !== id);
    data.records = data.records.filter((record) => record.job_id !== id);
    data.pages = data.pages.filter((page) => page.job_id !== id);
    touch();
  }

  // --- scheduling ---------------------------------------------------
  async updateJobSchedule(
    id: string,
    input: { cron: string | null; tz: string; enabled: boolean; nextRunAt: string | null },
  ): Promise<Job> {
    const data = await load();
    const job = data.jobs.find((item) => item.id === id);
    if (!job) throw new Error(`Job ${id} not found`);

    job.schedule_cron = input.cron;
    job.schedule_tz = input.tz;
    job.schedule_enabled = input.enabled && Boolean(input.cron);
    job.next_run_at = job.schedule_enabled ? input.nextRunAt : null;
    job.updated_at = nowIso();
    touch();
    return job;
  }

  async listDueJobs(
    limit = 50,
  ): Promise<Array<{ id: string; name: string; orgId: string; cron: string; tz: string; nextRunAt: string | null }>> {
    const data = await load();
    const now = Date.now();
    return data.jobs
      .filter((job) => job.schedule_enabled && Boolean(job.schedule_cron) && job.status !== 'cancelled' && job.status !== 'running')
      // A missing next_run_at means "never scheduled"; treat it as due so a
      // freshly enabled schedule is not silently ignored forever.
      .filter((job) => !job.next_run_at || Date.parse(job.next_run_at) <= now)
      .slice(0, limit)
      .map((job) => ({
        id: job.id,
        name: job.name,
        orgId: job.org_id,
        cron: job.schedule_cron as string,
        tz: job.schedule_tz,
        nextRunAt: job.next_run_at,
      }));
  }

  // --- runs ---------------------------------------------------------
  async listRuns(jobId: string, limit = QUERY_LIMITS.runs): Promise<JobRun[]> {
    const data = await load();
    return data.runs
      .filter((run) => run.job_id === jobId)
      .sort((a, b) => b.run_number - a.run_number)
      .slice(0, limit);
  }

  async listRecentRuns(limit = 20): Promise<JobRun[]> {
    const data = await load();
    return [...data.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit);
  }

  async getRun(id: string): Promise<JobRun | null> {
    const data = await load();
    return data.runs.find((run) => run.id === id) ?? null;
  }

  async createRun(jobId: string, trigger: JobRun['trigger']): Promise<JobRun> {
    const data = await load();
    const job = data.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const timestamp = nowIso();
    const run: JobRun = {
      id: randomUUID(),
      job_id: jobId,
      org_id: job.org_id,
      run_number: Math.max(0, ...data.runs.filter((item) => item.job_id === jobId).map((item) => item.run_number)) + 1,
      status: 'running',
      trigger,
      triggered_by: DEMO_USER.id,
      started_at: timestamp,
      finished_at: null,
      duration_ms: null,
      pages_ok: 0,
      pages_failed: 0,
      pages_total: 0,
      records_count: 0,
      records_new: 0,
      records_changed: 0,
      bytes_downloaded: 0,
      ai_tokens_used: 0,
      ai_cost_usd: 0,
      log: [{ at: timestamp, level: 'info', stage: 'queue', message: `Run #${job.run_count + 1} queued` }],
      error_code: null,
      error_message: null,
      created_at: timestamp,
    };
    data.runs.unshift(run);
    job.status = 'running';
    job.last_run_at = timestamp;
    job.run_count += 1;
    touch();
    return run;
  }

  async updateRun(id: string, patch: Partial<JobRun>): Promise<JobRun> {
    const data = await load();
    const run = data.runs.find((item) => item.id === id);
    if (!run) throw new Error(`Run ${id} not found`);
    Object.assign(run, patch);

    const job = data.jobs.find((item) => item.id === run.job_id);
    if (job && patch.status && patch.status !== 'running') {
      job.status = patch.status === 'succeeded' ? 'succeeded' : patch.status === 'partial' ? 'partial' : patch.status === 'cancelled' ? 'cancelled' : 'failed';
      job.stats = {
        ...job.stats,
        lastRunId: run.id,
        lastStatus: patch.status,
        lastDurationMs: run.duration_ms ?? undefined,
        lastPagesOk: run.pages_ok,
      };
    }
    touch();
    return run;
  }

  async deleteRun(id: string): Promise<void> {
    const data = await load();
    data.runs = data.runs.filter((run) => run.id !== id);
    // Pages belong to the run that fetched them, so they go too. Records are
    // extracted *data* — they survive, unlinked, because the user's dataset is
    // not a side effect of a run's bookkeeping row.
    data.pages = data.pages.filter((page) => page.run_id !== id);
    for (const record of data.records) {
      if (record.run_id === id) record.run_id = null;
    }
    touch();
  }

  async appendRunLog(id: string, entry: RunLogEntry): Promise<void> {
    const data = await load();
    const run = data.runs.find((item) => item.id === id);
    if (!run) return;
    run.log = [...run.log.slice(-199), entry];
    touch();
  }

  // --- data ---------------------------------------------------------
  async listPages(jobId: string, limit = QUERY_LIMITS.pages): Promise<PageRow[]> {
    const data = await load();
    return data.pages
      .filter((page) => page.job_id === jobId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  async listRecords(query: RecordQuery): Promise<Paginated<RecordRow>> {
    const data = await load();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(query.pageSize ?? QUERY_LIMITS.recordsPageSize, QUERY_LIMITS.recordsMaxPageSize);

    let rows = data.records;
    if (query.jobId) rows = rows.filter((row) => row.job_id === query.jobId);
    if (query.changedOnly) rows = rows.filter((row) => row.is_changed);
    if (query.search) {
      const needle = query.search.toLowerCase();
      rows = rows.filter((row) => JSON.stringify(row.data).toLowerCase().includes(needle));
    }

    const sort = query.sort ?? 'newest';
    rows = [...rows].sort((a, b) => {
      if (sort === 'oldest') return a.created_at < b.created_at ? -1 : 1;
      if (sort === 'position') return a.position - b.position;
      return a.created_at < b.created_at ? 1 : -1;
    });

    const total = rows.length;
    const start = (page - 1) * pageSize;
    return {
      items: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      hasMore: start + pageSize < total,
    };
  }

  async upsertRecords(
    rows: Array<Omit<RecordRow, 'id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at'>>,
  ): Promise<{ inserted: number; updated: number; changed: number }> {
    const data = await load();
    const timestamp = nowIso();
    let inserted = 0;
    let updated = 0;
    let changed = 0;

    for (const row of rows) {
      // The dedupe key is (job_id, content_hash) — identical to the unique
      // index in Postgres, so demo mode and production behave the same way.
      const existing = data.records.find(
        (item) => item.job_id === row.job_id && item.content_hash === row.content_hash,
      );

      if (existing) {
        existing.last_seen_at = timestamp;
        existing.updated_at = timestamp;
        updated += 1;
        continue;
      }

      // Same position, different hash == the thing changed.
      const previous = data.records.find(
        (item) => item.job_id === row.job_id && item.page_id === row.page_id && item.position === row.position,
      );
      if (previous) changed += 1;

      data.records.push({
        ...row,
        id: randomUUID(),
        is_changed: Boolean(previous) || row.is_changed,
        previous_data: previous?.data ?? row.previous_data ?? null,
        first_seen_at: timestamp,
        last_seen_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      });
      inserted += 1;
    }

    const jobIds = new Set(rows.map((row) => row.job_id));
    for (const jobId of jobIds) {
      const job = data.jobs.find((item) => item.id === jobId);
      if (job) job.record_count = data.records.filter((item) => item.job_id === jobId).length;
    }

    touch();
    return { inserted, updated, changed };
  }

  async insertPages(rows: Array<Omit<PageRow, 'id' | 'created_at'>>): Promise<PageRow[]> {
    const data = await load();
    const timestamp = nowIso();
    const created: PageRow[] = [];
    for (const row of rows) {
      const page: PageRow = { ...row, id: randomUUID(), created_at: timestamp };
      data.pages.push(page);
      created.push(page);
    }
    // Keep the file bounded; a long-running demo should not grow forever.
    if (data.pages.length > 5_000) data.pages = data.pages.slice(-5_000);
    if (data.records.length > 20_000) data.records = data.records.slice(-20_000);
    touch();
    return created;
  }

  // --- dashboard ----------------------------------------------------
  async dashboardStats(): Promise<DashboardStats> {
    const data = await load();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const runsToday = data.runs.filter((run) => new Date(run.created_at) >= todayStart);
    const completed = data.runs.filter((run) => run.status === 'succeeded' || run.status === 'partial');
    const failed = runsToday.filter((run) => run.status === 'failed' || run.status === 'partial');

    const throughput: DashboardStats['throughput'] = [];
    for (let offset = 13; offset >= 0; offset -= 1) {
      const day = new Date(Date.now() - offset * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      const dayRuns = data.runs.filter((run) => run.created_at.slice(0, 10) === key);
      throughput.push({
        date: key,
        records: dayRuns.reduce((sum, run) => sum + run.records_count, 0),
        pages: dayRuns.reduce((sum, run) => sum + run.pages_total, 0),
      });
    }

    return {
      totalJobs: data.jobs.length,
      activeJobs: data.jobs.filter((job) => job.status === 'running' || job.status === 'queued' || job.schedule_enabled).length,
      totalRecords: data.records.length,
      recordsToday: runsToday.reduce((sum, run) => sum + run.records_new, 0),
      runsToday: runsToday.length,
      failedToday: failed.length,
      pagesToday: runsToday.reduce((sum, run) => sum + run.pages_total, 0),
      successRate: completed.length === 0 ? 1 : completed.length / Math.max(1, data.runs.length),
      avgDurationMs: completed.length === 0 ? 0 : Math.round(completed.reduce((sum, run) => sum + (run.duration_ms ?? 0), 0) / completed.length),
      throughput,
    };
  }

  // --- credentials --------------------------------------------------
  async listApiKeys(): Promise<ApiKey[]> {
    const data = await load();
    return data.apiKeys.filter((key) => !key.revoked_at);
  }

  async createApiKey(input: { name: string; scopes: string[]; hash: string; prefix: string; expiresAt?: string | null }): Promise<ApiKey> {
    const data = await load();
    const key: ApiKey = {
      id: randomUUID(),
      org_id: DEMO_ORG.id,
      name: input.name,
      prefix: input.prefix,
      scopes: input.scopes,
      last_used_at: null,
      request_count: 0,
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
      created_by: DEMO_USER.id,
      created_at: nowIso(),
    };
    // The demo store keeps the hash alongside the row, mirroring the column
    // that exists in Postgres but is never exposed by a SELECT policy.
    (key as ApiKey & { key_hash?: string }).key_hash = input.hash;
    data.apiKeys.push(key);
    touch();
    return key;
  }

  async revokeApiKey(id: string): Promise<void> {
    const data = await load();
    const key = data.apiKeys.find((item) => item.id === id);
    if (key) key.revoked_at = nowIso();
    touch();
  }

  async listWebhookSecrets(): Promise<Array<{ id: string; url: string; events: string[]; secret: string }>> {
    const data = await load();
    return data.webhooks
      .filter((webhook) => webhook.is_active)
      .map((webhook) => ({
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        secret: data.webhookSecrets[webhook.id] ?? '',
      }))
      .filter((entry) => entry.secret.length > 0);
  }

  async listWebhooks(): Promise<Webhook[]> {
    const data = await load();
    return data.webhooks
      .filter((webhook) => webhook.is_active)
      // Never hand a signing secret to a caller that only needs a list.
      .map(({ ...webhook }) => {
        delete (webhook as Webhook & { signing_secret?: string }).signing_secret;
        return webhook;
      });
  }

  async createWebhook(input: { url: string; description?: string | null; events: string[]; secret: string }): Promise<Webhook> {
    const data = await load();
    const timestamp = nowIso();
    const webhook: Webhook = {
      id: randomUUID(),
      org_id: DEMO_ORG.id,
      url: input.url,
      description: input.description ?? null,
      events: input.events,
      is_active: true,
      created_at: timestamp,
      updated_at: timestamp,
    };
    data.webhookSecrets[webhook.id] = input.secret;
    data.webhooks.push(webhook);
    touch();
    return webhook;
  }

  async updateWebhook(
    id: string,
    patch: { url?: string; description?: string | null; events?: string[]; isActive?: boolean; secret?: string },
  ): Promise<Webhook> {
    const data = await load();
    const webhook = data.webhooks.find((item) => item.id === id);
    if (!webhook) throw new Error(`Webhook ${id} not found`);

    if (patch.url !== undefined) webhook.url = patch.url;
    if (patch.description !== undefined) webhook.description = patch.description;
    if (patch.events !== undefined) webhook.events = patch.events;
    if (patch.isActive !== undefined) webhook.is_active = patch.isActive;
    if (patch.secret !== undefined) data.webhookSecrets[id] = patch.secret;
    webhook.updated_at = nowIso();
    touch();
    return webhook;
  }

  async deleteWebhook(id: string): Promise<void> {
    const data = await load();
    const webhook = data.webhooks.find((item) => item.id === id);
    if (!webhook) return;
    // Soft delete, like SupabaseStore: the row documents that a webhook
    // existed, and its secret is destroyed so nothing can sign as it again.
    webhook.is_active = false;
    webhook.updated_at = nowIso();
    delete data.webhookSecrets[id];
    touch();
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
    const data = await load();
    data.usage.push({
      id: data.usage.length + 1,
      org_id: DEMO_ORG.id,
      kind: input.kind,
      quantity: input.quantity,
      unit_cost_usd: input.unitCostUsd ?? 0,
      job_id: input.jobId ?? null,
      run_id: input.runId ?? null,
      metadata: (input.metadata ?? {}) as UsageEvent['metadata'],
      occurred_at: nowIso(),
    });
    touch();
  }

  async listUsage(days: number): Promise<UsageEvent[]> {
    const data = await load();
    const cutoff = Date.now() - days * 86_400_000;
    return data.usage.filter((event) => new Date(event.occurred_at).getTime() >= cutoff);
  }

  async aiTokensThisMonth(): Promise<number> {
    const data = await load();
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    return data.usage
      .filter((event) => event.kind === 'ai_tokens' && new Date(event.occurred_at) >= monthStart)
      .reduce((sum, event) => sum + event.quantity, 0);
  }
}

export { DATA_FILE };
