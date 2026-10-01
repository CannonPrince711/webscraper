import { errors } from '@webscraper/shared';
import { jsonOk, route } from '@/lib/api';
import { safeEqual } from '@/lib/crypto';
import { env, features } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runSchedulerTick } from '@/lib/schedule';

/**
 * The scheduler tick.
 *
 * Point any cron you trust at this endpoint (Vercel Cron, GitHub Actions,
 * Kubernetes CronJob, an external uptime service) once a minute. It finds jobs
 * whose `next_run_at` has passed and hands them to the worker queue.
 *
 * Authentication: `Authorization: Bearer $CRON_SECRET`.
 *
 *  - **With a secret set**, a wrong or missing secret is a 401, compared in
 *    constant time so the endpoint cannot be used as an oracle.
 *  - **With no secret set in production**, the endpoint refuses to run (503).
 *    It does not "fail open" — an unauthenticated endpoint that can start
 *    arbitrary scrapes across every tenant is a denial-of-wallet waiting to
 *    happen.
 *  - **In development**, it runs unauthenticated so the demo instance works
 *    out of the box, and logs that it did.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorize(request: Request): void {
  if (!env.CRON_SECRET) {
    if (env.NODE_ENV === 'production') {
      throw errors.internal(
        'cron_secret_missing',
        'Scheduling is disabled: set CRON_SECRET to enable the scheduler endpoint.',
      );
    }
    logger.warn('Scheduler ran without CRON_SECRET (development only)');
    return;
  }

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const supplied = bearer || request.headers.get('x-cron-secret')?.trim() || '';

  if (!supplied || !safeEqual(supplied, env.CRON_SECRET)) {
    throw errors.unauthorized('Invalid scheduler credentials.');
  }
}

async function tick(request: Request) {
  authorize(request);

  const started = Date.now();
  const result = await runSchedulerTick(50);

  if (result.blockedReason) {
    // 200 with a reason rather than an error: the scheduler is healthy, the
    // deployment is incomplete, and the response body says exactly that.
    logger.warn('Scheduler tick could not dispatch', { reason: result.blockedReason });
  }

  return jsonOk({
    ...result,
    demoMode: features.demoMode,
    queueConfigured: features.redis,
    durationMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  });
}

export const GET = route(tick);
/** Some schedulers only issue POST; both are accepted and identical. */
export const POST = route(tick);
