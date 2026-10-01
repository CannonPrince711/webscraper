import 'server-only';
import { after } from 'next/server';
import { QUEUE_NAMES, errors, type JobRun } from '@webscraper/shared';
import { env, features } from './env';
import { logger } from './logger';
import { executeRun } from './runner';
import { getStore } from './store';

/**
 * Job dispatch.
 *
 * With `REDIS_URL` set, a run is handed to the worker via BullMQ: durable,
 * retried, and it survives the web process restarting. Without it, the run
 * executes inline *after the response is sent* (`after()`), so the user still
 * gets an immediate 202 and the browser is not held open for a long crawl.
 *
 * The inline path is deliberately limited and says so: it cannot resume a
 * crashed crawl, and it runs in the same process that serves traffic. That is
 * an acceptable trade for a demo instance and unacceptable for production,
 * which is why `configurationWarnings()` reports it on every boot.
 */

interface QueueJobPayload {
  jobId: string;
  runId: string;
  orgId: string;
  trigger: JobRun['trigger'];
  enqueuedAt: string;
}

// BullMQ connections are expensive; reuse one per process.
type QueueLike = { add: (name: string, data: QueueJobPayload, options?: Record<string, unknown>) => Promise<unknown> };

let scrapeQueue: QueueLike | null = null;
let queueInitFailed = false;

async function getScrapeQueue(): Promise<QueueLike | null> {
  if (!features.redis || queueInitFailed) return null;
  if (scrapeQueue) return scrapeQueue;

  try {
    const { Queue } = await import('bullmq');
    const { default: IORedis } = await import('ioredis');

    const connection = new IORedis(env.REDIS_URL as string, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
      lazyConnect: false,
    });
    connection.on('error', (error: Error) => {
      logger.warn('Redis connection error', { reason: error.name });
    });

    scrapeQueue = new Queue(QUEUE_NAMES.scrape, {
      connection,
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3_600, count: 500 },
        removeOnFail: { age: 86_400 },
      },
    }) as unknown as QueueLike;

    return scrapeQueue;
  } catch (error) {
    queueInitFailed = true;
    logger.exception('Failed to initialise the job queue', error);
    return null;
  }
}

export interface EnqueueResult {
  mode: 'queued' | 'inline';
}

/**
 * Dispatch a run. The caller has already created the `job_runs` row, so a
 * queue failure still leaves an auditable record of the attempt.
 */
export async function enqueueRun(payload: Omit<QueueJobPayload, 'enqueuedAt'>): Promise<EnqueueResult> {
  const queue = await getScrapeQueue();

  if (queue) {
    try {
      await queue.add(
        'run',
        { ...payload, enqueuedAt: new Date().toISOString() },
        // A deterministic jobId makes enqueueing idempotent: a double-click or
        // a retried request cannot start the same run twice.
        { jobId: payload.runId },
      );
      logger.info('Run queued', { runId: payload.runId, jobId: payload.jobId });
      return { mode: 'queued' };
    } catch (error) {
      logger.exception('Queueing failed; falling back to inline execution', error, { runId: payload.runId });
    }
  }

  // Inline: run after the response is flushed.
  after(async () => {
    try {
      await executeRun({ jobId: payload.jobId, runId: payload.runId, trigger: payload.trigger });
    } catch (error) {
      logger.exception('Inline run failed', error, { runId: payload.runId });
    }
  });

  return { mode: 'inline' };
}

/** Cancel a run: best-effort, and never claims more than it can do. */
export async function cancelRun(runId: string): Promise<boolean> {
  const queue = await getScrapeQueue();
  if (!queue) {
    // Inline runs share the web process; there is no handle to reach into.
    return false;
  }
  try {
    const job = await (queue as unknown as { getJob: (id: string) => Promise<{ remove: () => Promise<void> } | undefined> }).getJob(runId);
    if (!job) return false;
    await job.remove();
    return true;
  } catch (error) {
    logger.warn('Failed to cancel a queued run', { reason: (error as Error).name });
    return false;
  }
}

/** Create the run row and dispatch it. Shared by the API route and the UI action. */
export async function startRun(jobId: string, trigger: JobRun['trigger'] = 'manual'): Promise<{ run: JobRun; mode: EnqueueResult['mode'] }> {
  const store = await getStore();
  const job = await store.getJob(jobId);
  if (!job) throw errors.notFound('Job');
  if (job.status === 'running') {
    throw errors.invalidConfig('This job is already running. Wait for it to finish, or cancel it first.');
  }

  const run = await store.createRun(jobId, trigger);
  const { mode } = await enqueueRun({ jobId, runId: run.id, orgId: job.org_id, trigger });
  return { run, mode };
}
