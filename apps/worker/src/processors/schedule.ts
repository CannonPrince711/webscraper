import { nextRunAt } from '@webscraper/shared';
import { dueSchedules, getJob, setNextRun, supabase } from '../db.js';
import { logger } from '../logger.js';
import { enqueueRun } from '../queues.js';

/**
 * The scheduler.
 *
 * A repeatable BullMQ job fires this every minute; it finds jobs whose
 * `next_run_at` has passed and enqueues a run for each. It is written to be safe
 * to run **more than once per tick** and on more than one worker:
 *
 *  - Dispatch is claimed with an atomic `update … where next_run_at <= now()`
 *    that also advances the timestamp, so two workers racing the same job
 *    cannot both enqueue it. Only the update that actually changed a row
 *    proceeds.
 *  - `next_run_at` is advanced from **now**, not from the stale value, so a
 *    scheduler that was down for a week produces one run, not 168.
 */

export function computeNextRun(cron: string, timeZone: string): string | null {
  try {
    const next = nextRunAt(cron, new Date(), timeZone);
    return next ? next.toISOString() : null;
  } catch {
    // An invalid expression was rejected when it was saved; if one slips
    // through, disable the schedule rather than fail the whole tick.
    return null;
  }
}

export interface TickSummary {
  checked: number;
  dispatched: number;
  skipped: number;
}

export async function runSchedulerTick(limit = 50): Promise<TickSummary> {
  const due = await dueSchedules(limit);
  let dispatched = 0;
  let skipped = 0;

  for (const schedule of due) {
    const next = computeNextRun(schedule.cron, schedule.tz);

    // Claim the slot: this update only succeeds for one caller because the
    // timestamp must still be in the past.
    const { data: claimed, error } = await supabase
      .from('jobs')
      .update({ next_run_at: next, schedule_enabled: next !== null, status: 'queued' })
      .eq('id', schedule.id)
      .lte('next_run_at', new Date().toISOString())
      .select('id');

    if (error) {
      logger.warn('Could not claim a scheduled job', { jobId: schedule.id, code: error.code });
      skipped += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) {
      // Another worker got there first.
      skipped += 1;
      continue;
    }

    const job = await getJob(schedule.id);
    if (!job) {
      skipped += 1;
      continue;
    }

    try {
      const { data: runId, error: runError } = await supabase.rpc('create_job_run', {
        p_job_id: job.id,
        p_trigger: 'schedule',
        p_triggered_by: null,
      });
      if (runError || !runId) throw new Error(runError?.message ?? 'create_job_run returned nothing');

      await enqueueRun({ jobId: job.id, runId: runId as string, orgId: job.org_id, trigger: 'schedule' });
      dispatched += 1;
      logger.info('Scheduled run enqueued', { jobId: job.id, runId, next });
    } catch (error) {
      skipped += 1;
      // Give the slot back so the next tick retries rather than losing it.
      await setNextRun(job.id, new Date().toISOString());
      logger.exception('Failed to enqueue a scheduled run', error, { jobId: job.id });
    }
  }

  return { checked: due.length, dispatched, skipped };
}
