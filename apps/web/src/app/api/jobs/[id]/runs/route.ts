import { errors } from '@webscraper/shared';
import { intParam, jsonOk, route } from '@/lib/api';
import { QUERY_LIMITS, getStore } from '@/lib/store';

/**
 * Run history for a job.
 *
 * Kept separate from `GET /api/jobs/[id]` so the job detail page can refresh
 * the run list (the thing that actually changes) without re-fetching the job
 * and its pages. The cap is the store's, not the client's: `limit` is clamped
 * server-side, so `?limit=100000` is a no-op rather than an outage.
 */
export const GET = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();

  const job = await store.getJob(id);
  if (!job) throw errors.notFound('Job');

  const url = new URL(request.url);
  const limit = intParam(url.searchParams.get('limit'), 25, 1, QUERY_LIMITS.runs);

  const runs = await store.listRuns(id, limit);

  return jsonOk({
    jobId: id,
    runs,
    limit,
    hasMore: runs.length === limit,
  });
});
