import { errors } from '@webscraper/shared';
import { jsonOk, route } from '@/lib/api';
import { cancelRun } from '@/lib/queue';
import { getStore } from '@/lib/store';

/**
 * Cancel a run.
 *
 * Honesty matters here. A queued run can genuinely be pulled off the queue;
 * an inline (or already-executing) run cannot — the fetcher is mid-flight in
 * another process. In that case we mark it `cancelled` so the UI stops waiting
 * and record that the worker may still finish its current page, rather than
 * pretending the work stopped instantly.
 */
export const POST = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot cancel runs.');

  const run = await store.getRun(id);
  if (!run) throw errors.notFound('Run');

  if (run.status !== 'running' && run.status !== 'queued') {
    return jsonOk({ cancelled: false, status: run.status, reason: 'already_finished' });
  }

  const removedFromQueue = await cancelRun(id);
  const updated = await store.updateRun(id, {
    status: 'cancelled',
    finished_at: new Date().toISOString(),
    duration_ms: run.started_at ? Date.now() - Date.parse(run.started_at) : null,
    error_code: 'cancelled',
    error_message: 'Cancelled by the user.',
  });

  await store.appendRunLog(id, {
    at: new Date().toISOString(),
    level: 'warn',
    stage: 'cancel',
    message: removedFromQueue
      ? 'Run removed from the queue before it started.'
      : 'Cancellation requested. A run already in flight finishes its current page.',
  });

  return jsonOk({ cancelled: true, status: updated.status, removedFromQueue });
});
