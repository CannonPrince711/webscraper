import { errors } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { describeCron, isValidCron, nextRunAt } from '@webscraper/shared';
import { features } from '@/lib/env';
import { planSchedule, saveSchedule } from '@/lib/schedule';
import { getStore } from '@/lib/store';
import { SUPPORTED_TIME_ZONE_HINT } from '@/lib/timezones';

/**
 * A job's schedule.
 *
 * Kept out of `PATCH /api/jobs/[id]` because scheduling has its own failure
 * modes: an expression can be syntactically valid but never fire (31 February),
 * and the user needs the *computed* next three fire times as feedback rather
 * than a silent save. The response always returns those, plus a plain-English
 * description of the expression.
 */

const scheduleSchema = z.object({
  cron: z.string().trim().max(120).nullable(),
  tz: z.string().trim().max(64).default('UTC'),
  enabled: z.boolean().default(true),
});

function stateFor(job: { schedule_cron: string | null; schedule_tz: string; schedule_enabled: boolean; next_run_at: string | null }) {
  return {
    cron: job.schedule_cron,
    tz: job.schedule_tz,
    enabled: job.schedule_enabled,
    nextRunAt: job.next_run_at,
    description: job.schedule_cron ? describeCron(job.schedule_cron) : 'Manual only',
    valid: job.schedule_cron ? isValidCron(job.schedule_cron) : true,
  };
}

export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();

  const job = await store.getJob(id);
  if (!job) throw errors.notFound('Job');

  // Show the next three fire times so a "0 0 31 2 *"-style mistake is obvious.
  const upcoming: string[] = [];
  if (job.schedule_enabled && job.schedule_cron && isValidCron(job.schedule_cron)) {
    let cursor = new Date();
    for (let index = 0; index < 3; index += 1) {
      const next = nextRunAt(job.schedule_cron, cursor, job.schedule_tz);
      if (!next) break;
      upcoming.push(next.toISOString());
      cursor = next;
    }
  }

  return jsonOk({
    schedule: stateFor(job),
    upcoming,
    workerAvailable: features.redis || !features.supabase,
    timeZoneHint: SUPPORTED_TIME_ZONE_HINT,
  });
});

export const PUT = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot change schedules.');

  const parsed = scheduleSchema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  // Validate before touching the database, so an impossible expression returns
  // a field-level 400 rather than saving something that will never run.
  const planned = planSchedule(parsed.data);

  const job = await saveSchedule(store, id, parsed.data);

  const upcoming: string[] = [];
  if (planned.enabled && planned.cron) {
    let cursor = new Date();
    for (let index = 0; index < 3; index += 1) {
      const next = nextRunAt(planned.cron, cursor, planned.tz);
      if (!next) break;
      upcoming.push(next.toISOString());
      cursor = next;
    }
  }

  return jsonOk({
    schedule: stateFor(job),
    upcoming,
    // Honest about the fact that a schedule in a worker-less deployment will
    // not fire. The UI turns this into a banner, not an error.
    workerAvailable: features.redis || !features.supabase,
  });
});
