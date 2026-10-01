import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES } from '@webscraper/shared';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Queue definitions.
 *
 * One Redis connection is shared by every queue in the process (ioredis pools
 * internally); BullMQ requires `maxRetriesPerRequest: null` or blocking reads
 * fail on the first reconnect.
 *
 * Retry policy by queue, because "retry" means different things:
 *
 *  - `scrape` — 2 retries. A crawl is expensive; retrying it three times turns a
 *    flaky target into a self-inflicted load spike.
 *  - `ai` — 3 retries. Model providers rate-limit, and backoff genuinely helps.
 *  - `deliver` — 6 retries with a long exponential tail. A receiver that is down
 *    for an hour should still get its event.
 *  - `schedule` — no retries. It ticks again in 60 seconds anyway.
 */

export const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on('error', (error: Error) => logger.warn('Redis connection error', { name: error.name }));

const shared: JobsOptions = {
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const scrapeQueue = new Queue(QUEUE_NAMES.scrape, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: { ...shared, attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
});

export const aiQueue = new Queue(QUEUE_NAMES.ai, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: { ...shared, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
});

export const deliverQueue = new Queue(QUEUE_NAMES.deliver, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: { ...shared, attempts: 6, backoff: { type: 'exponential', delay: 15_000 } },
});

export const scheduleQueue = new Queue(QUEUE_NAMES.schedule, {
  connection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: { ...shared, attempts: 1 },
});

export interface RunQueuePayload {
  jobId: string;
  runId: string;
  orgId: string;
  trigger: string;
  enqueuedAt?: string;
}

/** Enqueue a run. The deterministic job id makes a double enqueue a no-op. */
export async function enqueueRun(payload: RunQueuePayload): Promise<void> {
  await scrapeQueue.add('run', { ...payload, enqueuedAt: new Date().toISOString() }, { jobId: payload.runId });
}

/** Retry a webhook delivery by ledger id. */
export async function enqueueDelivery(deliveryId: string, delayMs = 0): Promise<void> {
  await deliverQueue.add('deliver', { deliveryId }, { jobId: `deliver:${deliveryId}`, delay: delayMs });
}

/**
 * Register the repeatable scheduler tick.
 *
 * BullMQ 6 replaced per-job `repeat` options with *job schedulers*, which are
 * keyed by id and idempotent: calling this on every boot updates the schedule
 * rather than creating a second one. (The old `repeat` option is gone from
 * `JobsOptions` — it does not merely warn.)
 */
export async function registerSchedulerTick(): Promise<void> {
  await scheduleQueue.upsertJobScheduler(
    'scheduler-tick',
    { every: 60_000 },
    {
      name: 'tick',
      data: { at: new Date().toISOString() },
      opts: { removeOnComplete: true, removeOnFail: 100 },
    },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([scrapeQueue.close(), aiQueue.close(), deliverQueue.close(), scheduleQueue.close()]);
  connection.disconnect();
}

/** Depth of every queue, for the worker's /healthz and for debugging. */
export async function queueDepths(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    [
      ['scrape', scrapeQueue],
      ['ai', aiQueue],
      ['deliver', deliverQueue],
      ['schedule', scheduleQueue],
    ].map(async ([name, queue]) => {
      try {
        const counts = await (queue as Queue).getJobCounts('waiting', 'active', 'delayed', 'failed');
        return [name as string, Object.values(counts).reduce((total, value) => total + value, 0)] as const;
      } catch {
        return [name as string, -1] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
