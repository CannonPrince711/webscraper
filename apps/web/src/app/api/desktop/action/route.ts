import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { assertLocalRequest, desktop } from '@/lib/desktop';
import { getStore } from '@/lib/store';

const schema = z.object({ action: z.enum(['check-update', 'install-update', 'restart', 'shutdown']) });

/**
 * Runs that were in flight when the app is stopped can never finish. Left as
 * `running` they would sit there forever (and block their scheduled job), so
 * close them out as interrupted. `failed` rather than `cancelled`: the
 * scheduler skips cancelled jobs, and an interrupted run should not switch a
 * schedule off.
 */
async function interruptActiveRuns(): Promise<number> {
  const store = await getStore();
  const now = new Date().toISOString();
  let count = 0;
  for (const run of await store.listRecentRuns(500)) {
    if (run.status !== 'running' && run.status !== 'queued') continue;
    await store.updateRun(run.id, {
      status: 'failed',
      finished_at: now,
      duration_ms: run.started_at ? Date.now() - Date.parse(run.started_at) : null,
      error_code: 'interrupted',
      error_message: 'Interrupted because the app was stopped.',
    });
    await store.appendRunLog(run.id, { at: now, level: 'warn', stage: 'stop', message: 'App stopped while this run was in progress.' });
    count += 1;
  }
  return count;
}

/** Update, restart and stop controls, forwarded to the launcher's loopback API. */
export const POST = route(async (request) => {
  assertLocalRequest(request);
  const parsed = schema.safeParse(await readJson(request, 1_000));
  if (!parsed.success) throw fromZod(parsed.error);

  switch (parsed.data.action) {
    case 'check-update':
      return jsonOk(await desktop.checkForUpdate());
    case 'install-update':
      return jsonOk(await desktop.installUpdate());
    case 'restart':
      await interruptActiveRuns();
      return jsonOk(await desktop.restart());
    case 'shutdown': {
      const interrupted = await interruptActiveRuns();
      await desktop.shutdown();
      return jsonOk({ ok: true, interrupted });
    }
  }
});
