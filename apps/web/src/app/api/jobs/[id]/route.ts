import { errors, jobStatusesSchema, scrapeConfigSchema } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { getStore } from '@/lib/store';

/** Single-job endpoints. Every handler re-checks ownership through the store. */

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    config: scrapeConfigSchema.optional(),
    tags: z.array(z.string().trim().max(40)).max(20).optional(),
    status: jobStatusesSchema.optional(),
    scheduleCron: z.string().trim().max(120).nullable().optional(),
    scheduleEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();

  const job = await store.getJob(id);
  if (!job) throw errors.notFound('Job');

  const [runs, pages] = await Promise.all([store.listRuns(id, 25), store.listPages(id, 100)]);

  return jsonOk({ job, runs, pages });
});

export const PATCH = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot edit jobs.');

  const existing = await store.getJob(id);
  if (!existing) throw errors.notFound('Job');

  const parsed = patchSchema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  if (parsed.data.config && parsed.data.config.limits.maxPages > orgContext.org.limits.maxPagesPerJob) {
    throw errors.quotaExceeded(
      `Your plan allows at most ${orgContext.org.limits.maxPagesPerJob} pages per job.`,
    );
  }

  const job = await store.updateJob(id, parsed.data);
  return jsonOk({ job });
});

export const DELETE = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer' || orgContext.role === 'member') {
    // Deleting a job destroys its collected data; that is an admin action.
    throw errors.forbidden('Only owners and admins can delete a job.');
  }

  const job = await store.getJob(id);
  if (!job) throw errors.notFound('Job');

  await store.deleteJob(id);
  return jsonOk({ deleted: true, id });
});
