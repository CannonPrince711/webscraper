import { Worker, type Job } from 'bullmq';
import { QUEUE_NAMES } from '@webscraper/shared';
import { env } from './env.js';
import { recordDelivery, recordRunResult, startHealthServer, stopHealthServer } from './health.js';
import { logger } from './logger.js';
import { safeProcessEnrichment } from './processors/ai.js';
import { processDelivery } from './processors/deliver.js';
import { processRun, type RunJobPayload } from './processors/scrape.js';
import { runSchedulerTick } from './processors/schedule.js';
import { closeQueues, connection, registerSchedulerTick } from './queues.js';

/**
 * The worker process.
 *
 * One process, four queues, with separate concurrency per queue because they
 * contend for different resources: runs are CPU/IO heavy and limited by
 * `WORKER_CONCURRENCY`; webhook deliveries are almost entirely waiting on
 * someone else's HTTP server, so they can be much wider.
 *
 * Shutdown is graceful on purpose. Kubernetes sends SIGTERM and then kills the
 * process a few seconds later; a worker that ignores it loses the run it was
 * executing, and the user sees a job stuck in `running` forever.
 */

const workers: Worker[] = [];
let shuttingDown = false;

function startScrapeWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.scrape,
    async (job: Job<RunJobPayload>) => {
      logger.info('Processing run', { jobId: job.data.jobId, runId: job.data.runId, attempt: job.attemptsMade + 1 });
      await processRun(job.data);
      recordRunResult(true);
    },
    {
      connection,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
      // Crawls are long: lock renewal must comfortably exceed the slowest batch.
      lockDuration: Math.min(env.RUN_TIMEOUT_MS, 900_000),
      limiter: { max: env.WORKER_CONCURRENCY * 4, duration: 60_000 },
    },
  );

  worker.on('failed', (job, error) => {
    recordRunResult(false);
    logger.error('Run job failed', {
      jobId: job?.data?.jobId,
      runId: job?.data?.runId,
      attempts: job?.attemptsMade,
      error: error?.message,
    });
  });

  return worker;
}

function startAiWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.ai,
    async (job: Job<Parameters<typeof safeProcessEnrichment>[0]>) => {
      await safeProcessEnrichment(job.data);
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: 2 },
  );
  worker.on('failed', (job, error) => logger.warn('Enrichment job failed', { jobId: job?.id, error: error?.message }));
  return worker;
}

function startDeliverWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.deliver,
    async (job: Job<{ deliveryId: string }>) => {
      await processDelivery(job.data);
      recordDelivery();
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: env.DELIVER_CONCURRENCY },
  );
  worker.on('failed', (job, error) =>
    logger.warn('Delivery job failed', { deliveryId: job?.data?.deliveryId, error: error?.message }),
  );
  return worker;
}

function startScheduleWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.schedule,
    async () => {
      const summary = await runSchedulerTick(50);
      if (summary.dispatched > 0 || summary.checked > 0) {
        logger.info('Scheduler tick', {
          checked: summary.checked,
          dispatched: summary.dispatched,
          skipped: summary.skipped,
        });
      }
    },
    { connection, prefix: env.QUEUE_PREFIX, concurrency: 1 },
  );
  worker.on('failed', (_job, error) => logger.warn('Scheduler tick failed', { error: error?.message }));
  return worker;
}

async function main(): Promise<void> {
  logger.info('Worker starting', {
    engine: env.ENGINE_URL,
    concurrency: env.WORKER_CONCURRENCY,
    uploadArtifacts: env.UPLOAD_ARTIFACTS,
  });

  startHealthServer();

  workers.push(startScrapeWorker(), startAiWorker(), startDeliverWorker(), startScheduleWorker());
  await registerSchedulerTick();

  logger.info('Worker ready', { queues: Object.values(QUEUE_NAMES) });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });

  // Stop accepting new jobs, then let in-flight work finish (BullMQ waits for
  // the current job up to the close timeout).
  const deadline = Date.now() + 25_000;
  await Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));

  if (Date.now() > deadline) {
    logger.warn('Shutdown took longer than expected; some runs may be retried by the queue.');
  }

  await closeQueues();
  await stopHealthServer();
  logger.info('Worker stopped');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});

main().catch((error) => {
  logger.exception('Worker failed to start', error);
  process.exit(1);
});
