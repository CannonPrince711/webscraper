import { errors, jobModeSchema, scrapeConfigSchema } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, intParam, jsonOk, readJson, route } from '@/lib/api';
import { engine } from '@/lib/engine';
import { logger } from '@/lib/logger';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Job collection endpoints.
 *
 * Validation happens here, with the *same* schema the engine enforces, so the
 * API can reject a config the engine would reject rather than discovering it
 * three layers down. Targets are also checked against the egress policy before
 * the job is saved — a user should learn "that resolves to a private address"
 * while filling in the form, not from a failed run an hour later.
 */

const createJobSchema = z.object({
  name: z.string().trim().min(1, 'Give the job a name').max(200),
  mode: jobModeSchema.default('single'),
  config: scrapeConfigSchema,
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  scheduleCron: z.string().trim().max(120).nullable().default(null),
  scheduleEnabled: z.boolean().default(false),
  projectId: z.string().uuid().nullable().default(null),
});

export const GET = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();
  const url = new URL(request.url);

  await enforceRateLimit(`jobs:list:${context.org.id}`, { max: 240, windowMs: 60_000 });

  const jobs = await store.listJobs({
    limit: intParam(url.searchParams.get('limit'), 100, 1, 200),
    status: url.searchParams.get('status') ?? undefined,
  });

  return jsonOk({ jobs, demo: context.demo });
});

export const POST = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();

  // Creating jobs touches the network (target pre-flight) and the queue, so it
  // is limited more tightly than reads.
  await enforceRateLimit(`jobs:create:${context.org.id}`, { max: 30, windowMs: 60_000 });

  const parsed = createJobSchema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  const input = parsed.data;
  if (context.role === 'viewer') throw errors.forbidden('Viewers cannot create jobs.');

  // Enforce the org's plan ceiling, not just the global one.
  if (input.config.limits.maxPages > context.org.limits.maxPagesPerJob) {
    throw errors.quotaExceeded(
      `Your plan allows at most ${context.org.limits.maxPagesPerJob} pages per job. Reduce the page limit or upgrade.`,
    );
  }

  // Pre-flight the targets. A failure here is advisory: the user may
  // legitimately want to save a job whose target is temporarily unreachable,
  // so only SSRF blocks are hard errors.
  try {
    const check = await engine.checkTargets(input.config.targets);
    const blocked = check.results.filter((result) => !result.allowed);
    if (blocked.length === input.config.targets.length) {
      throw errors.ssrfBlocked(
        blocked[0]?.reason ?? 'None of those targets are reachable public addresses.',
      );
    }
    if (blocked.length > 0) {
      logger.info('Some targets were rejected by the egress policy', {
        blocked: blocked.length,
        total: check.results.length,
        code: blocked[0]?.code,
      });
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ssrf_blocked') throw error;
    // The engine being unavailable must not prevent saving a job: it is
    // validated again at run time, which is where it actually matters.
    logger.warn('Target pre-flight skipped: engine unavailable');
  }

  const job = await store.createJob({
    name: input.name,
    mode: input.mode,
    config: input.config,
    tags: input.tags,
    scheduleCron: input.scheduleCron,
    scheduleEnabled: input.scheduleEnabled,
    projectId: input.projectId,
  });

  return jsonOk({ job }, { status: 201 });
});
