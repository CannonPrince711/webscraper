import { WEBHOOK_EVENTS, assertWebhookUrl, errors } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';
import { generateWebhookSecret } from '@/lib/webhooks';

/**
 * Webhook endpoints.
 *
 * Two decisions worth calling out:
 *
 *  - **The signing secret is returned exactly once.** It has to be reversible
 *    (we reproduce the HMAC on every delivery), so it cannot be hashed like an
 *    API key; the next best thing is to show it once, store it behind column
 *    grants no user session can read, and offer rotation.
 *  - **The URL is validated before it is stored.** A webhook is a request *we*
 *    make from inside our network; without the check, "add a webhook" is an
 *    SSRF primitive aimed at cloud metadata endpoints.
 */

const eventSchema = z.union([z.enum(WEBHOOK_EVENTS), z.literal('*')]);

const createSchema = z.object({
  url: z.string().trim().min(8).max(2048),
  description: z.string().trim().max(200).nullable().default(null),
  events: z.array(eventSchema).min(1, 'Choose at least one event.').max(WEBHOOK_EVENTS.length + 1),
});

export const GET = route(async () => {
  const store = await getStore();
  await store.getOrgContext();

  // Secrets are deliberately absent from this response — this payload is
  // rendered in a browser.
  const webhooks = await store.listWebhooks();
  return jsonOk({
    webhooks,
    availableEvents: [...WEBHOOK_EVENTS],
    signing: {
      header: 'X-Webscraper-Signature',
      format: 't=<unix>,v1=<hex hmac of "{t}.{body}">',
      toleranceSeconds: 300,
      docs: '/docs/ARCHITECTURE.md#webhooks',
    },
  });
});

export const POST = route(async (request) => {
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer' || orgContext.role === 'member') {
    throw errors.forbidden('Only owners and admins can manage webhooks.');
  }

  await enforceRateLimit(`webhooks:create:${orgContext.org.id}`, { max: 20, windowMs: 60_000 });

  const parsed = createSchema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  const url = assertWebhookUrl(parsed.data.url);
  const secret = generateWebhookSecret();

  const webhook = await store.createWebhook({
    url: url.toString(),
    description: parsed.data.description,
    events: [...new Set(parsed.data.events)],
    secret,
  });

  return jsonOk(
    {
      webhook,
      secret,
      warning: 'Copy the signing secret now. It is shown once and stored only where the delivery worker can read it.',
    },
    { status: 201 },
  );
});
