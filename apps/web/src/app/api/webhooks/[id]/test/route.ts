import { errors } from '@webscraper/shared';
import { jsonOk, route } from '@/lib/api';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';
import { findDeliveryTarget, sendTestDelivery } from '@/lib/webhooks';

/**
 * Send a test delivery.
 *
 * The response is a report, not a boolean: receivers fail in boring ways
 * (401 because the secret is wrong, 404 because the path changed, a timeout
 * because a firewall drops our egress), and each of those needs a different
 * fix. Reporting the status code and the round-trip time turns "webhooks
 * aren't working" into a one-line diagnosis.
 *
 * The payload is synthetic — no scraped data is sent — so this button is safe
 * to press against an endpoint that is still being built.
 */
export const POST = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot send test deliveries.');

  // A test is an outbound request to a third party; keep it rare.
  await enforceRateLimit(`webhooks:test:${orgContext.org.id}`, { max: 10, windowMs: 60_000 });

  const webhooks = await store.listWebhooks();
  const webhook = webhooks.find((candidate) => candidate.id === id);
  if (!webhook) throw errors.notFound('Webhook');
  if (!webhook.is_active) throw errors.invalidConfig('That webhook is disabled.');

  const target = await findDeliveryTarget(store, id);
  if (!target) {
    // In Supabase mode this means the service-role key is missing, which is the
    // same reason real deliveries would be skipped. Say that, rather than
    // sending something we cannot sign.
    throw errors.internal(
      'webhook_secret_unavailable',
      'The signing secret is not readable on this deployment, so a test cannot be signed. set SUPABASE_SERVICE_ROLE_KEY to enable webhook delivery.',
    );
  }

  const result = await sendTestDelivery({ url: target.url, secret: target.secret });

  return jsonOk({
    ...result,
    url: target.url,
    signed: true,
    hint: result.ok
      ? 'Your endpoint accepted the delivery. Check that the signature verified on your side too.'
      : 'Fix the endpoint, then send another test. Nothing was retried.',
  });
});
