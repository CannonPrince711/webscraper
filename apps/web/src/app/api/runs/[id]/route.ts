import { errors } from '@webscraper/shared';
import { jsonOk, route } from '@/lib/api';
import { getStore } from '@/lib/store';

/**
 * A single run, with its full log tail.
 *
 * The log is capped at write time (see `append_run_log` in the migrations and
 * `appendRunLog` in the stores), so this route can return the whole thing
 * without a pagination dance.
 */
export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();

  const run = await store.getRun(id);
  if (!run) throw errors.notFound('Run');

  const [job, pages] = await Promise.all([store.getJob(run.job_id), store.listPages(run.job_id, 25)]);

  return jsonOk({
    run,
    job: job
      ? { id: job.id, name: job.name, mode: job.mode, status: job.status, config: job.config }
      : null,
    pages,
  });
});

export const DELETE = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot delete runs.');

  const run = await store.getRun(id);
  if (!run) throw errors.notFound('Run');

  // Deleting history is allowed; deleting a *live* run is not, because the
  // worker owns that row and would keep writing to it.
  if (run.status === 'running' || run.status === 'queued') {
    throw errors.conflict('Cancel this run before deleting it.');
  }

  await store.deleteRun(id);
  return jsonOk({ deleted: true, id });
});
