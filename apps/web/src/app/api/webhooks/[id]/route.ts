import { WEBHOOK_EVENTS, assertWebhookUrl, errors } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { getStore } from '@/lib/store';
import { generateWebhookSecret } from '@/lib/webhooks';

/**
 * Update or remove a webhook.
 *
 * `rotateSecret: true` mints a new signing secret and returns it once. Rotation
 * is not an afterthought: a secret that has been pasted into a third-party
 * config by hand is the most likely thing to leak, and if rotating it takes a
 * support ticket, nobody will.
 */

const patchSchema = z
  .object({
    url: z.string().trim().min(8).max(2048).optional(),
    description: z.string().trim().max(200).nullable().optional(),
    events: z.array(z.union([z.enum(WEBHOOK_EVENTS), z.literal('*')])).min(1).max(WEBHOOK_EVENTS.length + 1).optional(),
    isActive: z.boolean().optional(),
    rotateSecret: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export const PATCH = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer' || orgContext.role === 'member') {
    throw errors.forbidden('Only owners and admins can manage webhooks.');
  }

  const parsed = patchSchema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  const { rotateSecret, url, events, ...rest } = parsed.data;

  // The secret is generated here and returned here. Reading it back from the
  // store would fail in Supabase mode by design (the column is not readable by
  // a user session), and there is no reason to round-trip a value we just made.
  const newSecret = rotateSecret ? generateWebhookSecret() : null;

  const webhook = await store.updateWebhook(id, {
    ...rest,
    ...(url !== undefined ? { url: assertWebhookUrl(url).toString() } : {}),
    ...(events !== undefined ? { events: [...new Set(events)] } : {}),
    ...(newSecret ? { secret: newSecret } : {}),
  });

  return jsonOk({
    webhook,
    ...(newSecret
      ? {
          secret: newSecret,
          warning: 'The previous secret is now invalid. Update your receiver before the next run.',
        }
      : {}),
  });
});

export const DELETE = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer' || orgContext.role === 'member') {
    throw errors.forbidden('Only owners and admins can manage webhooks.');
  }

  const webhooks = await store.listWebhooks();
  if (!webhooks.some((webhook) => webhook.id === id)) throw errors.notFound('Webhook');

  // Soft delete: the row documents that a webhook existed, and the secret is
  // destroyed so nothing can sign as it again.
  await store.deleteWebhook(id);
  return jsonOk({ deleted: true, id });
});
