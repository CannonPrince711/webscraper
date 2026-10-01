import { errors, runTriggersSchema } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { enforceRateLimit } from '@/lib/rate-limit';
import { startRun } from '@/lib/queue';
import { getStore } from '@/lib/store';

/**
 * Start a run.
 *
 * The response is a 202 with the run id, never a 200 with results: a crawl can
 * take minutes, and holding the request open would tie up a connection and
 * time out at every proxy in the chain. The UI subscribes to the run instead.
 */

const runSchema = z.object({
  trigger: runTriggersSchema.default('manual'),
});

export const POST = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot start runs.');

  await enforceRateLimit(`run:${orgContext.org.id}`, { max: 60, windowMs: 60_000 });

  const parsed = runSchema.safeParse(await readJson(request).catch(() => ({})));
  if (!parsed.success) throw fromZod(parsed.error);

  const { run, mode } = await startRun(id, parsed.data.trigger);

  return jsonOk(
    {
      runId: run.id,
      status: run.status,
      runNumber: run.run_number,
      // Tells the UI whether progress will arrive over the queue or inline, so
      // it can label the run honestly instead of promising a worker.
      execution: mode,
    },
    { status: 202 },
  );
});
