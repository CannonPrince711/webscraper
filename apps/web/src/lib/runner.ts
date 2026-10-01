import 'server-only';
import {
  contentHash,
  normalizeUrl,
  runCrawlLoop,
  statusPresentation,
  toAppError,
  type EnginePageResult,
  type Job,
  type JobRun,
  type PageRow,
  type PageStatus,
  type RecordRow,
  type RunLogEntry,
  type ScrapeConfig,
} from '@webscraper/shared';
import { features } from './env';
import { engine } from './engine';
import { logger } from './logger';
import { getStore, type Store } from './store';
import { deliverWebhooks } from './webhooks';

/**
 * Executes one job run end to end.
 *
 * This is the inline path — used when Redis is not configured (demo mode and
 * single-process deployments). When Redis *is* configured, the same work happens
 * in `apps/worker`, which adds resumable crawl state, AI enrichment and webhook
 * retries. The crawl *rules* are shared via `runCrawlLoop`, so the two cannot
 * disagree about scope or dedupe.
 *
 * Failure handling is deliberately non-fatal at the page level: one blocked URL
 * must never fail a 500-page run. Only an engine-level failure ends the run
 * early, and it is recorded with a reason the user can act on.
 */

export interface RunOptions {
  jobId: string;
  runId: string;
  trigger?: JobRun['trigger'];
  signal?: AbortSignal;
}

const ENGINE_TIMEOUT_MS = 240_000;

function mapStatus(status: string): PageStatus {
  switch (status) {
    case 'ok':
      return 'fetched';
    case 'not_modified':
      return 'not_modified';
    case 'http_error':
      return 'http_error';
    case 'blocked_robots':
      return 'blocked_robots';
    case 'blocked_ssrf':
      return 'blocked_ssrf';
    case 'timeout':
      return 'timeout';
    case 'too_large':
      return 'too_large';
    case 'skipped':
      return 'skipped';
    default:
      return 'error';
  }
}

async function log(store: Store, runId: string, entry: Omit<RunLogEntry, 'at'>): Promise<void> {
  const full: RunLogEntry = { at: new Date().toISOString(), ...entry };
  try {
    await store.appendRunLog(runId, full);
  } catch (error) {
    // A log write must never break a run.
    logger.debug('Failed to append a run log entry', { reason: toAppError(error).code });
  }
}

/** Persist pages, then their records, and keep the ids linked. */
async function persistPages(
  store: Store,
  job: Job,
  runId: string,
  pages: EnginePageResult[],
): Promise<{ inserted: number; updated: number; changed: number; pageRows: number }> {
  const now = new Date().toISOString();

  const pageRows: Array<Omit<PageRow, 'id' | 'created_at'>> = pages.map((page) => ({
    org_id: job.org_id,
    job_id: job.id,
    run_id: runId,
    url: page.url,
    url_hash: normalizeUrl(page.finalUrl || page.url),
    canonical_url: page.canonicalUrl ?? null,
    status: mapStatus(page.status),
    http_status: page.httpStatus ?? null,
    depth: page.depth ?? 0,
    content_type: page.contentType ?? null,
    content_hash: page.contentHash ?? null,
    title: page.title ?? null,
    lang: page.lang ?? null,
    bytes: page.bodyBytes ?? null,
    duration_ms: page.durationMs ?? null,
    fetch_method: page.fetchMethod ?? null,
    artifact_html_path: null,
    artifact_screenshot_path: null,
    // The engine already bounded this; the column exists for search and for the
    // sandboxed preview.
    markdown: page.markdown ? page.markdown.slice(0, 200_000) : null,
    metadata: (page.metadata ?? {}) as PageRow['metadata'],
    error_code: page.errorCode ?? null,
    error_message: page.errorMessage ?? null,
  }));

  const created = await store.insertPages(pageRows);
  const pageIdByUrl = new Map<string, string>();
  for (const row of created) {
    pageIdByUrl.set(normalizeUrl(row.url), row.id);
    pageIdByUrl.set(row.url_hash, row.id);
  }

  const recordRows: Array<Omit<RecordRow, 'id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at'>> = [];

  for (const page of pages) {
    const pageId = pageIdByUrl.get(normalizeUrl(page.finalUrl || page.url)) ?? null;
    for (const [index, record] of (page.records ?? []).entries()) {
      // Hash the canonical record so an unchanged re-run produces the same key
      // and updates `last_seen_at` instead of creating a duplicate.
      const hash = await contentHash(record);
      recordRows.push({
        org_id: job.org_id,
        job_id: job.id,
        run_id: runId,
        page_id: pageId,
        position: index,
        source_url: page.finalUrl ?? page.url,
        data: record as RecordRow['data'],
        enriched: null,
        content_hash: hash,
        is_changed: false,
        previous_data: null,
      });
    }
  }

  const result = recordRows.length > 0 ? await store.upsertRecords(recordRows) : { inserted: 0, updated: 0, changed: 0 };
  void now;

  return { ...result, pageRows: created.length };
}

/**
 * Run one job. Returns the finalised run row.
 *
 * Never throws for page-level problems; throws only if the job itself is gone.
 */
export async function executeRun(options: RunOptions): Promise<JobRun> {
  const store = await getStore();
  const { jobId, runId } = options;

  const job = await store.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} does not exist`);

  const config: ScrapeConfig = job.config;
  const startedAt = Date.now();

  await store.updateRun(runId, { status: 'running', started_at: new Date().toISOString() });
  await log(store, runId, { level: 'info', stage: 'engine', message: `Starting ${config.mode} run against ${config.targets.length} target(s)` });

  let pagesOk = 0;
  let pagesFailed = 0;
  let bytesTotal = 0;
  let recordsInserted = 0;
  let recordsUpdated = 0;
  let recordsChanged = 0;
  const allPages: EnginePageResult[] = [];

  try {
    // --- 1. Crawl (or single fetch) ---------------------------------
    const outcome = await runCrawlLoop({
      targets: config.targets,
      crawl: config.crawl,
      mode: config.mode,
      maxPages: config.limits.maxPages,
      signal: options.signal,
      isAllowed: () => true, // the engine enforces the SSRF policy authoritatively
      fetchBatch: async ({ urls, depth }) => {
        const response = await engine.scrape(
          {
            config,
            urls,
            depth,
            deadlineMs: ENGINE_TIMEOUT_MS,
          },
          { timeoutMs: ENGINE_TIMEOUT_MS },
        );
        return { results: response.results, discovered: response.discovered };
      },
      onBatch: async (batch) => {
        // Persist incrementally: a crash mid-crawl leaves usable data, and the
        // UI can show progress as it happens rather than all at the end.
        const batchPages = batch;
        const persisted = await persistPages(store, job, runId, batchPages);
        recordsInserted += persisted.inserted;
        recordsUpdated += persisted.updated;
        recordsChanged += persisted.changed;

        for (const page of batchPages) {
          allPages.push(page);
          if (page.status === 'ok' || page.status === 'not_modified') pagesOk += 1;
          else pagesFailed += 1;
          bytesTotal += page.bodyBytes ?? 0;
        }

        await store.updateRun(runId, {
          pages_ok: pagesOk,
          pages_failed: pagesFailed,
          pages_total: pagesOk + pagesFailed,
          records_count: recordsInserted + recordsUpdated,
          records_new: recordsInserted,
          records_changed: recordsChanged,
          bytes_downloaded: bytesTotal,
        });
        await log(store, runId, {
          level: 'info',
          stage: 'crawl',
          message: `Fetched ${batchPages.length} page(s) — ${pagesOk} ok, ${pagesFailed} failed`,
        });
      },
    });

    if (outcome.truncated) {
      await log(store, runId, {
        level: 'warn',
        stage: 'crawl',
        message: `Stopped at the page limit (${Math.min(config.limits.maxPages, config.crawl.maxPages)}). Raise max pages to continue.`,
      });
    }
    if (outcome.skipped.length > 0) {
      const byReason = outcome.skipped.reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] ?? 0) + 1;
        return acc;
      }, {});
      await log(store, runId, {
        level: 'debug',
        stage: 'scope',
        message: `Skipped ${outcome.skipped.length} URL(s): ${Object.entries(byReason).map(([reason, count]) => `${count} ${reason}`).join(', ')}`,
      });
    }

    // --- 2. Meter usage ---------------------------------------------
    await store.recordUsage({
      kind: 'page_fetch',
      quantity: pagesOk + pagesFailed,
      unitCostUsd: 0.00004,
      jobId,
      runId,
      metadata: { mode: config.mode },
    });
    const browserRenders = allPages.filter((page) => page.rendered).length;
    if (browserRenders > 0) {
      await store.recordUsage({ kind: 'browser_render', quantity: browserRenders, unitCostUsd: 0.0009, jobId, runId });
    }

    // --- 3. Finalise -------------------------------------------------
    const durationMs = Date.now() - startedAt;
    const status: JobRun['status'] =
      pagesFailed === 0 && pagesOk > 0 ? 'succeeded' : pagesOk === 0 ? 'failed' : 'partial';

    const finished = await store.updateRun(runId, {
      status,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      pages_ok: pagesOk,
      pages_failed: pagesFailed,
      pages_total: pagesOk + pagesFailed,
      records_count: recordsInserted + recordsUpdated,
      records_new: recordsInserted,
      records_changed: recordsChanged,
      bytes_downloaded: bytesTotal,
      error_code: status === 'failed' ? (allPages[0]?.errorCode ?? 'no_pages') : null,
      error_message:
        status === 'failed'
          ? (allPages[0]?.errorMessage ?? 'No pages could be fetched. Check the targets and the failure details.')
          : null,
    });

    await log(store, runId, {
      level: status === 'succeeded' ? 'info' : 'warn',
      stage: 'done',
      message: `Finished: ${statusPresentation(status).label} — ${recordsInserted} new, ${recordsChanged} changed`,
    });

    // --- 4. Deliver ---------------------------------------------------
    await deliverWebhooks(store, job, finished).catch((error) => {
      logger.warn('Webhook delivery failed', { jobId, reason: toAppError(error).code });
    });

    return finished;
  } catch (error) {
    const appError = toAppError(error, 'The run could not be completed.');
    logger.exception('Run failed', error, { jobId, runId, code: appError.code });

    await store.updateRun(runId, {
      status: appError.code === 'engine_unavailable' ? 'timeout' : 'failed',
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      pages_ok: pagesOk,
      pages_failed: pagesFailed,
      pages_total: pagesOk + pagesFailed,
      records_count: recordsInserted + recordsUpdated,
      error_code: appError.code,
      error_message: appError.message,
    });
    await log(store, runId, { level: 'error', stage: 'done', message: appError.message, meta: { code: appError.code } });

    const finished = await store.getRun(runId);
    if (finished) await deliverWebhooks(store, job, finished).catch(() => undefined);
    throw appError;
  }
}

/** True when the inline runner is the active execution path. */
export const runsInline = !features.redis;
