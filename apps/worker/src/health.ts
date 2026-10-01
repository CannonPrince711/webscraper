import { createServer, type Server } from 'node:http';
import { engine } from './engine.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { queueDepths } from './queues.js';

/**
 * A tiny health server.
 *
 * Kubernetes, Fly, Railway and every other orchestrator want an HTTP probe —
 * without one, a worker that is alive but stuck (Redis unreachable, engine
 * gone) looks healthy until someone notices no jobs are moving. `/healthz`
 * reports the two dependencies that matter and the queue depths, so
 * "is it working" is one `curl` away.
 *
 * It is intentionally *not* a full metrics stack: `/metrics` is Prometheus text
 * with the few numbers that matter (queue depth, active jobs, engine up/down).
 */

let server: Server | null = null;
const startedAt = Date.now();
const counters = { runsProcessed: 0, runsFailed: 0, deliveriesProcessed: 0 };

export function recordRunResult(ok: boolean): void {
  counters.runsProcessed += 1;
  if (!ok) counters.runsFailed += 1;
}

export function recordDelivery(): void {
  counters.deliveriesProcessed += 1;
}

export function startHealthServer(): void {
  if (env.HEALTH_PORT === 0) return;

  server = createServer((request, response) => {
    if (request.url === '/metrics') {
      void (async () => {
        const depths = await queueDepths();
        const lines = [
          '# HELP webscraper_runs_processed_total Runs handled by this worker.',
          '# TYPE webscraper_runs_processed_total counter',
          `webscraper_runs_processed_total ${counters.runsProcessed}`,
          '# TYPE webscraper_runs_failed_total counter',
          `webscraper_runs_failed_total ${counters.runsFailed}`,
          '# TYPE webscraper_deliveries_processed_total counter',
          `webscraper_deliveries_processed_total ${counters.deliveriesProcessed}`,
          '# TYPE webscraper_uptime_seconds gauge',
          `webscraper_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
        ];
        for (const [queue, depth] of Object.entries(depths)) {
          lines.push(`webscraper_queue_depth{queue="${queue}"} ${depth}`);
        }
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(`${lines.join('\n')}\n`);
      })();
      return;
    }

    if (request.url === '/healthz' || request.url === '/') {
      void (async () => {
        const [engineUp, depths] = await Promise.all([engine.ready(), queueDepths()]);
        const body = {
          status: engineUp ? 'ok' : 'degraded',
          engine: engineUp ? 'up' : 'down',
          queues: depths,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        };
        response.writeHead(engineUp ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      })();
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(env.HEALTH_PORT, '0.0.0.0', () => {
    logger.info('Health server listening', { port: env.HEALTH_PORT });
  });
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}
