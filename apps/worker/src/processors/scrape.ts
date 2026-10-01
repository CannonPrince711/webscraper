import {
  contentHash,
  normalizeUrl,
  runCrawlLoop,
  safeParseScrapeConfig,
  toAppError,
  type EnginePageResult,
  type Json,
  type PageRow,
  type PageStatus,
  type RecordRow,
  type RunLogEntry,
  type ScrapeConfig,
  type Job,
} from '@webscraper/shared';
import { engine, withRetry } from '../engine.js';
import {
  appendLog,
  ensureRun,
  finalizeRun,
  getJob,
  getRun,
  insertPages,
  isCancelled,
  recordUsage,
  setNextRun,
  updateRun,
  upsertRecords,
} from '../db.js';
import { notifyRunEvent } from '../delivery.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { computeNextRun } from './schedule.js';

/**
 * Execute one job run: crawl, extract, persist, notify.
 *
 * Failure policy, in one paragraph: **page-level failures never fail a run.**
 * A 404, a robots block or a timeout is data about that page — it is stored on
 * the page row and the crawl continues. Only failures that make the whole run
 * meaningless (an invalid config, an unreachable engine) end it early, and they
 * end it with an error code the user can act on.
 */

export interface RunJobPayload {
  jobId: string;
  runId: string;
  orgId: string;
  trigger: string;
  enqueuedAt?: string;
}

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

async function log(runId: string, entry: Omit<RunLogEntry, 'at'>): Promise<void> {
  await appendLog(runId, { at: new Date().toISOString(), ...entry });
}

/** Persist a batch of pages and the records extracted from them. */
async function persistBatch(
  job: Job,
  runId: string,
  pages: EnginePageResult[],
): Promise<{ pagesInserted: number; recordsInserted: number; recordsChanged: number; bytes: number }> {
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
    // The engine already caps markdown at 200k characters; the column keeps it
    // so the data explorer can show a page's content without a second fetch.
    markdown: page.markdown ? page.markdown.slice(0, 200_000) : null,
    metadata: (page.metadata ?? {}) as Json,
    error_code: page.errorCode ?? null,
    error_message: page.errorMessage ?? null,
  }));

  const createdPages = await insertPages(pageRows);
  const pageIdByUrl = new Map<string, string>();
  for (const row of createdPages) {
    pageIdByUrl.set(normalizeUrl(row.url), row.id);
    if (row.url_hash) pageIdByUrl.set(row.url_hash, row.id);
  }

  const recordRows: Array<Omit<RecordRow, 'id' | 'created_at' | 'updated_at' | 'first_seen_at' | 'last_seen_at'>> = [];

  for (const page of pages) {
    const pageId = pageIdByUrl.get(normalizeUrl(page.finalUrl || page.url)) ?? pageIdByUrl.get(normalizeUrl(page.url)) ?? null;

    for (const [index, data] of page.records.entries()) {
      // Belt and braces: the engine should never emit a non-object record, but a
      // stray array here would be written straight into jsonb and break the UI.
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

      // `contentHash` is async (Web Crypto / subtle.digest). The hash is the
      // dedupe key on `(job_id, content_hash)`, so it must be the same function
      // the web app uses — not a hand-rolled shortcut.
      const hash = await contentHash(data as Record<string, unknown>);
      const confidence = page.recordConfidences?.[index];
      const enriched = confidence !== undefined && confidence < 0.2 ? { _lowConfidence: true } : null;

      recordRows.push({
        org_id: job.org_id,
        job_id: job.id,
        run_id: runId,
        page_id: pageId,
        position: index,
        source_url: page.finalUrl || page.url,
        data: data as Record<string, Json>,
        enriched,
        content_hash: hash,
        is_changed: false,
        previous_data: null,
      });
    }
  }

  const result = await upsertRecords(recordRows);
  return {
    pagesInserted: createdPages.length,
    recordsInserted: result.inserted,
    recordsChanged: result.changed,
    bytes: pages.reduce((total, page) => total + (page.bodyBytes ?? 0), 0),
  };
}

/** Enrich the run's records with the LLM, if the job asked for it. */
async function enrichRecords(job: Job, runId: string, config: ScrapeConfig): Promise<{ tokens: number; costUsd: number }> {
  if (config.ai.enrich.length === 0) return { tokens: 0, costUsd: 0 };

  const { supabase } = await import('../db.js');
  const { data, error } = await supabase
    .from('records')
    .select('id, data')
    .eq('run_id', runId)
    .limit(200);

  if (error || !data || data.length === 0) return { tokens: 0, costUsd: 0 };

  const rows = data as Array<{ id: string; data: Record<string, Json> }>;
  let tokens = 0;
  let costUsd = 0;

  // Sequential, in chunks of 25: parallel LLM calls are the fastest way to a
  // rate-limit ban, and enrichment is not latency-critical.
  for (let offset = 0; offset < rows.length; offset += 25) {
    const chunk = rows.slice(offset, offset + 25);
    const response = await withRetry(
      () =>
        engine.enrich({
          records: chunk.map((row) => row.data),
          tasks: [...config.ai.enrich],
          labels: config.ai.labels,
          instructions: config.ai.instructions,
          model: config.ai.model,
        }),
      2,
    );

    tokens += response.usage?.totalTokens ?? 0;
    costUsd += response.usage?.costUsd ?? 0;

    for (const [index, row] of chunk.entries()) {
      const enrichment = response.results?.[index];
      if (!enrichment) continue;
      await supabase.from('records').update({ enriched: enrichment }).eq('id', row.id);
    }
  }

  return { tokens, costUsd };
}

export async function processRun(payload: RunJobPayload): Promise<void> {
  const started = Date.now();
  const job = await getJob(payload.jobId);

  if (!job) {
    logger.warn('Job disappeared before its run started', { jobId: payload.jobId, runId: payload.runId });
    return;
  }

  // The config in the database was written by the app, but it is still parsed
  // here: the engine's settings may have changed since (a new limit, a removed
  // strategy), and a run must not execute a config the current schema rejects.
  const parsed = safeParseScrapeConfig(job.config);
  if (!parsed.success) {
    const runId = await ensureRun(job.id, payload.runId, payload.trigger as never);
    await log(runId, {
      level: 'error',
      stage: 'validate',
      message: 'This job’s configuration is no longer valid and the run was stopped.',
    });
    await finalizeRun(runId, 'failed', 'invalid_config', 'The stored configuration failed validation.');
    return;
  }

  const config = parsed.data;
  const runId = await ensureRun(job.id, payload.runId, payload.trigger as never);
  await updateRun(runId, { status: 'running', started_at: new Date().toISOString() });
  await log(runId, { level: 'info', stage: 'start', message: `Run started (${payload.trigger}); ${config.targets.length} target(s).` });

  let pagesOk = 0;
  let pagesFailed = 0;
  let recordsInserted = 0;
  let recordsChanged = 0;
  let bytesTotal = 0;
  let aborted = false;

  const startedAtMs = Date.now();

  try {
    const outcome = await runCrawlLoop<EnginePageResult>({
      targets: config.targets,
      crawl: config.crawl,
      mode: config.mode,
      maxPages: config.limits.maxPages,
      fetchBatch: async ({ urls, depth }) =>
        withRetry(() =>
          engine.scrape({
            config,
            urls,
            depth,
            deadlineMs: Math.min(config.limits.maxDurationMs, env.RUN_TIMEOUT_MS),
            requestId: `${runId}:${depth}`,
          }),
        ),
      onBatch: async (batch) => {
        const persisted = await persistBatch(job, runId, batch);
        pagesOk += batch.filter((page) => page.status === 'ok' || page.status === 'not_modified').length;
        pagesFailed += batch.filter((page) => page.status !== 'ok' && page.status !== 'not_modified').length;
        recordsInserted += persisted.recordsInserted;
        recordsChanged += persisted.recordsChanged;
        bytesTotal += persisted.bytes;

        await updateRun(runId, {
          pages_total: pagesOk + pagesFailed,
          pages_ok: pagesOk,
          pages_failed: pagesFailed,
          records_count: recordsInserted,
          records_new: recordsInserted,
          records_changed: recordsChanged,
          bytes_downloaded: bytesTotal,
        });

        // Cancellation is checked between batches: a run that is cancelled
        // mid-batch finishes the pages it already fetched, then stops.
        if (await isCancelled(runId)) {
          aborted = true;
          throw new AbortError('cancelled');
        }
      },
    });

    if (outcome.truncated) {
      await log(runId, {
        level: 'warn',
        stage: 'crawl',
        message: `Stopped at the page limit (${config.limits.maxPages}). Pages beyond it were not fetched.`,
      });
    }
    if (outcome.skipped.length > 0) {
      await log(runId, {
        level: 'info',
        stage: 'crawl',
        message: `${outcome.skipped.length} link(s) skipped by scope rules.`,
        meta: { examples: outcome.skipped.slice(0, 5) as unknown as Json },
      });
    }

    // The deadline is advisory at the engine level; enforce it here too.
    if (Date.now() - startedAtMs > config.limits.maxDurationMs) {
      await log(runId, { level: 'warn', stage: 'limits', message: 'The run reached its time limit; remaining pages were skipped.' });
    }

    const usage = await enrichRecords(job, runId, config).catch((error) => {
      // Enrichment is additive: losing it must not lose the scraped data.
      logger.exception('Enrichment failed', error, { runId });
      return { tokens: 0, costUsd: 0 };
    });

    const status = pagesFailed === 0 ? 'succeeded' : pagesOk > 0 ? 'partial' : 'failed';
    await updateRun(runId, {
      ai_tokens_used: usage.tokens,
      ai_cost_usd: usage.costUsd,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAtMs,
    });
    await finalizeRun(runId, status);
    await log(runId, {
      level: status === 'failed' ? 'error' : 'info',
      stage: 'done',
      message: `Finished: ${pagesOk} page(s) ok, ${pagesFailed} failed, ${recordsInserted} record(s).`,
    });

    await recordUsage({
      orgId: job.org_id,
      kind: 'page_fetch',
      quantity: pagesOk + pagesFailed,
      jobId: job.id,
      runId,
      metadata: { status },
    });

    // Rearm the schedule from *now*: a worker that was down for a week runs a
    // job once on recovery, not 168 times.
    if (job.schedule_enabled && job.schedule_cron) {
      const next = computeNextRun(job.schedule_cron, job.schedule_tz);
      setNextRun(job.id, next).catch(() => undefined);
    }

    const finalRun = await getRun(runId);
    if (finalRun) {
      // Never let a delivery problem fail the run that produced the data.
      await notifyRunEvent({ job, run: finalRun, orgId: job.org_id }).catch((error) => {
        logger.exception('Webhook fan-out failed', error, { runId });
      });
    }

    logger.info('Run finished', {
      runId,
      jobId: job.id,
      status,
      pagesOk,
      pagesFailed,
      recordsInserted,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    const cancelled = aborted || (error instanceof Error && error.name === 'AbortError');
    const appError = toAppError(error);

    if (cancelled) {
      await updateRun(runId, { finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAtMs });
      await finalizeRun(runId, 'cancelled', 'cancelled', 'Cancelled by the user.');
      await log(runId, { level: 'warn', stage: 'cancel', message: 'Run cancelled.' });
      return;
    }

    await finalizeRun(runId, 'failed', appError.code, appError.message);
    await log(runId, { level: 'error', stage: 'failed', message: appError.message });

    logger.exception('Run failed', error, { runId, jobId: job.id });

    // Rethrow retryable transport failures so BullMQ backs off and tries again;
    // a permanent failure (bad config, blocked target) is terminal.
    if (appError.retryable) throw error;
  }
}

/** Local stand-in for `AbortError` so the cancellation path needs no DOM types. */
class AbortError extends Error {
  override readonly name = 'AbortError';
}
