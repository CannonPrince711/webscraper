import 'server-only';
import { errors, type Job } from '@webscraper/shared';
import { CronError, assertValidTimeZone, isValidCron, nextRunAt } from '@webscraper/shared';
import { features } from './env';
import { logger } from './logger';
import { enqueueRun } from './queue';
import { createSupabaseAdminClient } from './supabase/admin';
import { DemoStore } from './store/demo';
import type { Store } from './store/types';

/**
 * Scheduling.
 *
 * Two separate concerns, kept apart on purpose:
 *
 *  1. **Planning** — turning `{cron, tz, enabled}` into a concrete
 *     `next_run_at`. Pure, testable, no database.
 *  2. **Ticking** — finding what is due and dispatching it. This runs with no
 *     user session, so in Supabase mode it is the *only* place in the web app
 *     (besides webhook fan-out) that touches the service-role client, and it
 *     only reads schedule metadata and creates a run.
 *
 * A due job is dispatched **once per tick** and its `next_run_at` is advanced
 * from *now* rather than from the stale value: if the scheduler was down for a
 * week, the job runs once when it comes back instead of firing 168 times. A
 * missed slot is a missed slot; a thundering herd against someone else's server
 * is a different problem entirely.
 */

export interface ScheduleInput {
  cron: string | null;
  tz: string;
  enabled: boolean;
}

export interface PlannedSchedule {
  cron: string | null;
  tz: string;
  enabled: boolean;
  nextRunAt: string | null;
}

/** Validate a schedule and work out when it should next fire. */
export function planSchedule(input: ScheduleInput, from: Date = new Date()): PlannedSchedule {
  let tz: string;
  try {
    tz = assertValidTimeZone(input.tz || 'UTC');
  } catch (error) {
    throw errors.invalidConfig(error instanceof Error ? error.message : 'Invalid time zone.');
  }

  const cron = input.cron?.trim() || null;
  if (cron && !isValidCron(cron)) {
    throw errors.invalidConfig(
      'That is not a valid cron expression. Use five fields, e.g. "0 */6 * * *" for every six hours.',
    );
  }

  // Enabled with no expression is not an error: it means "manual only".
  const enabled = input.enabled && cron !== null;

  let nextRunAtValue: string | null = null;
  if (enabled && cron) {
    const next = nextRunAt(cron, from, tz);
    if (!next) {
      throw errors.invalidConfig('That schedule never happens — check the day and month fields.');
    }
    nextRunAtValue = next.toISOString();
  }

  return { cron, tz, enabled, nextRunAt: nextRunAtValue };
}

/** Persist a schedule through the caller's (RLS-bound) store. */
export async function saveSchedule(store: Store, jobId: string, input: ScheduleInput): Promise<Job> {
  const job = await store.getJob(jobId);
  if (!job) throw errors.notFound('Job');
  const planned = planSchedule(input);
  return store.updateJobSchedule(jobId, planned);
}

/** Recompute `next_run_at` for a job whose schedule is unchanged (e.g. after a run). */
export async function rearmSchedule(store: Store, job: Job, from: Date = new Date()): Promise<Job> {
  if (!job.schedule_enabled || !job.schedule_cron) return job;
  const planned = planSchedule({ cron: job.schedule_cron, tz: job.schedule_tz, enabled: true }, from);
  return store.updateJobSchedule(job.id, planned);
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface DueSchedule {
  id: string;
  name: string;
  orgId: string;
  cron: string;
  tz: string;
  nextRunAt: string | null;
}

export interface TickDetail {
  jobId: string;
  jobName: string;
  outcome: 'dispatched' | 'skipped' | 'failed';
  runId?: string;
  reason?: string;
}

export interface TickResult {
  checked: number;
  dispatched: number;
  skipped: number;
  failed: number;
  details: TickDetail[];
  /** Populated when scheduling cannot work at all in this configuration. */
  blockedReason?: string;
}

function adminOrThrow() {
  const admin = createSupabaseAdminClient();
  if (!admin) throw errors.internal('Scheduling requires SUPABASE_SERVICE_ROLE_KEY in Supabase mode.');
  return admin;
}

/**
 * Every tenant's due schedules. Service-role only — the RLS-bound store would
 * return just the caller's org, and the cron tick has no caller.
 */
export async function dueSchedules(limit = 50): Promise<DueSchedule[]> {
  if (features.supabase) {
    const admin = adminOrThrow();
    // The view is `security_invoker`; the service role bypasses RLS, so this
    // legitimately sees every workspace. It returns schedule metadata only.
    const { data, error } = await admin
      .from('due_scheduled_jobs')
      .select('id, org_id, name, schedule_cron, schedule_tz, next_run_at')
      .limit(limit);
    if (error) throw errors.internal(`dueSchedules: ${error.code}`);
    return (data ?? []).map((row) => {
      const record = row as {
        id: string;
        org_id: string;
        name: string;
        schedule_cron: string;
        schedule_tz: string;
        next_run_at: string | null;
      };
      return {
        id: record.id,
        orgId: record.org_id,
        name: record.name,
        cron: record.schedule_cron,
        tz: record.schedule_tz,
        nextRunAt: record.next_run_at,
      };
    });
  }

  const store = new DemoStore();
  return store.listDueJobs(limit);
}

async function loadJobForTick(jobId: string): Promise<Job | null> {
  if (features.supabase) {
    const admin = adminOrThrow();
    const { data, error } = await admin.from('jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw errors.internal(`loadJobForTick: ${error.code}`);
    return (data as Job | null) ?? null;
  }
  return new DemoStore().getJob(jobId);
}

async function createScheduledRun(schedule: DueSchedule): Promise<string> {
  if (features.supabase) {
    // `create_job_run` assigns the run number under an advisory lock, so two
    // scheduler instances cannot both write run #7 for the same job.
    const admin = adminOrThrow();
    const { data, error } = await admin.rpc('create_job_run', {
      p_job_id: schedule.id,
      p_trigger: 'schedule',
      p_triggered_by: null,
    });
    if (error || !data) throw errors.internal(`createScheduledRun: ${error?.code}`);
    return data as string;
  }
  const run = await new DemoStore().createRun(schedule.id, 'schedule');
  return run.id;
}

async function advanceSchedule(schedule: DueSchedule, from: Date = new Date()): Promise<void> {
  // Advance from *now*, never from the stale value: no backfill storms.
  const next = nextRunAt(schedule.cron, from, schedule.tz);
  const nextIso = next?.toISOString() ?? null;

  if (features.supabase) {
    const admin = adminOrThrow();
    const { error } = await admin
      .from('jobs')
      .update({ next_run_at: nextIso, schedule_enabled: nextIso !== null })
      .eq('id', schedule.id);
    if (error) throw errors.internal(`advanceSchedule: ${error.code}`);
    return;
  }
  await new DemoStore().updateJobSchedule(schedule.id, {
    cron: schedule.cron,
    tz: schedule.tz,
    enabled: nextIso !== null,
    nextRunAt: nextIso,
  });
}

/** Run one scheduler tick: find what is due, create a run, hand it to the worker. */
export async function runSchedulerTick(limit = 50): Promise<TickResult> {
  const details: TickDetail[] = [];
  const result: TickResult = { checked: 0, dispatched: 0, skipped: 0, failed: 0, details };

  // In Supabase mode with no Redis there is no process that can execute the
  // run: the inline fallback needs a user session, and the cron tick has none.
  // Say so plainly instead of creating runs that will sit in `running` forever.
  if (features.supabase && !features.redis) {
    result.blockedReason =
      'REDIS_URL is not configured, so there is no worker to run scheduled jobs. Set REDIS_URL and start apps/worker.';
    logger.warn('Scheduler tick blocked', { reason: 'redis missing' });
    return result;
  }

  const due = await dueSchedules(limit);
  result.checked = due.length;

  for (const schedule of due) {
    try {
      const job = await loadJobForTick(schedule.id);
      if (!job) {
        result.skipped += 1;
        details.push({ jobId: schedule.id, jobName: schedule.name, outcome: 'skipped', reason: 'job_deleted' });
        await advanceSchedule(schedule);
        continue;
      }
      if (job.status === 'running') {
        result.skipped += 1;
        details.push({
          jobId: schedule.id,
          jobName: job.name,
          outcome: 'skipped',
          reason: 'previous_run_still_running',
        });
        await advanceSchedule(schedule);
        continue;
      }

      const runId = await createScheduledRun(schedule);
      await enqueueRun({ jobId: job.id, runId, orgId: job.org_id, trigger: 'schedule' });
      // Advance immediately after dispatch: if the worker then dies, the run
      // stays visible as `running` and can be retried from the UI.
      await advanceSchedule(schedule);

      result.dispatched += 1;
      details.push({ jobId: schedule.id, jobName: job.name, outcome: 'dispatched', runId });
      logger.info('Scheduled run dispatched', { jobId: schedule.id, runId });
    } catch (error) {
      result.failed += 1;
      const reason = error instanceof CronError ? error.message : 'dispatch_failed';
      details.push({ jobId: schedule.id, jobName: schedule.name, outcome: 'failed', reason });
      logger.exception('Scheduler failed to dispatch a job', error, { jobId: schedule.id });
    }
  }

  return result;
}
