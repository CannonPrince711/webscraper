import 'server-only';
import { createSupabaseAdminClient } from './supabase/admin';
import { features, env } from './env';
import { logger } from './logger';
import { randomToken, safeEqual, signPayload } from './crypto';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_USER_AGENT,
  buildWebhookPayload,
  assertWebhookUrl,
  eventForRunStatus,
  parseSignatureHeader,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type Job,
  type JobRun,
} from '@webscraper/shared';
import type { Store } from './store';

/**
 * Webhook delivery.
 *
 * Contract with receivers:
 *   - `POST` with `content-type: application/json`
 *   - `X-Webscraper-Signature: t=<unix>,v1=<hex>` where the HMAC is over
 *     `"{t}.{body}"`, so a captured request cannot be replayed once the window
 *     closes and a mutated body is rejected.
 *   - `X-Webscraper-Event: run.succeeded`
 *
 * Two things this deliberately does NOT do inline:
 *   - **Retry with backoff.** A single delivery attempt happens here; durable
 *     retries with a ledger live in the worker's `deliver` queue. Blocking a
 *     request on a slow third-party endpoint is how you get a timeout cascade.
 *   - **Read secrets through the RLS client.** `signing_secret` is excluded from
 *     every column grant to `authenticated`, so only the service-role client can
 *     read it. Without that key, delivery is skipped rather than unsigned —
 *     sending an unsigned payload would train receivers to trust one.
 */

const DELIVERY_TIMEOUT_MS = 10_000;

/** A fresh signing secret. Prefixed so it is recognisable in a scan. */
export function generateWebhookSecret(): string {
  return `whsec_${randomToken(24)}`;
}

/**
 * Send a synthetic `webhook.test` delivery. Returns the outcome instead of
 * throwing, because "did my endpoint answer, and with what status" is the
 * entire point of the button.
 */
export async function sendTestDelivery(target: { url: string; secret: string }): Promise<{
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}> {
  let url: URL;
  try {
    url = assertWebhookUrl(target.url);
  } catch (error) {
    return { ok: false, status: null, durationMs: 0, error: (error as Error).message };
  }

  const body = JSON.stringify({
    event: 'webhook.test',
    data: { message: 'This is a test delivery from Webscraper. No scraped data is included.' },
    sentAt: new Date().toISOString(),
  });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': WEBHOOK_USER_AGENT,
        [WEBHOOK_EVENT_HEADER]: 'webhook.test',
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(body, target.secret),
      },
      body,
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started,
      error: response.ok ? null : `The endpoint answered ${response.status}.`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      error: aborted ? 'The endpoint did not answer within 10 seconds.' : 'The endpoint could not be reached.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DeliveryTarget {
  id: string;
  url: string;
  events: string[];
  secret: string;
}

/** Resolve webhook endpoints *and their signing secrets* for an org. */
export async function resolveDeliveryTargets(store: Store, job: Job): Promise<DeliveryTarget[]> {
  // Demo mode / single-process: the local store holds the secret.
  if (store.kind === 'demo') {
    return store.listWebhookSecrets();
  }

  if (!features.serviceRole) {
    logger.warn('Webhook delivery skipped: SUPABASE_SERVICE_ROLE_KEY is not configured');
    return [];
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from('webhooks')
    .select('id, url, events, signing_secret')
    .eq('org_id', job.org_id)
    .eq('is_active', true);

  if (error) {
    logger.warn('Could not load webhooks', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    url: row.url as string,
    events: (row.events ?? []) as string[],
    secret: row.signing_secret as string,
  }));
}

/**
 * Resolve one webhook (and its secret) for the test-delivery button.
 *
 * Returns `null` when the secret cannot be read — in Supabase mode that means
 * the service-role key is missing. The caller reports that honestly rather than
 * sending an unsigned test the receiver will reject.
 */
export async function findDeliveryTarget(store: Store, webhookId: string): Promise<DeliveryTarget | null> {
  if (store.kind === 'demo') {
    return (await store.listWebhookSecrets()).find((target) => target.id === webhookId) ?? null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const { data } = await admin
    .from('webhooks')
    .select('id, url, events, signing_secret')
    .eq('id', webhookId)
    .eq('is_active', true)
    .maybeSingle();

  if (!data) return null;
  const row = data as { id: string; url: string; events: string[]; signing_secret: string };
  return { id: row.id, url: row.url, events: row.events, secret: row.signing_secret };
}

/**
 * Fire the run's webhooks. Never throws — a failing integration must not fail
 * the scrape that produced the data.
 */
export async function deliverWebhooks(store: Store, job: Job, run: JobRun): Promise<void> {
  const event = eventForRunStatus(run.status);

  let targets: DeliveryTarget[] = [];
  try {
    targets = await resolveDeliveryTargets(store, job);
  } catch (error) {
    logger.warn('Webhook resolution failed', { reason: (error as Error).name });
    return;
  }

  const matching = targets.filter((target) => target.events.includes(event) || target.events.includes('*'));
  if (matching.length === 0) return;

  // The payload shape lives in `@webscraper/shared` so the worker's retry path
  // produces byte-identical bodies — receivers verify one signature format, not
  // two that look similar.
  const payload = buildWebhookPayload({ event, job, run, appUrl: env.APP_URL });
  const body = JSON.stringify(payload);

  await Promise.allSettled(
    matching.map(async (target) => {
      // Re-check at delivery time: the URL was validated when it was saved, but
      // DNS is not a promise (rebinding), and the row may predate this check.
      try {
        assertWebhookUrl(target.url);
      } catch {
        logger.warn('Webhook target rejected by the egress policy at delivery time');
        return;
      }

      // `signPayload` already produces the full `t=<unix>,v1=<hex>` header.
      const signature = signPayload(body, target.secret);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      try {
        const response = await fetch(target.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': WEBHOOK_USER_AGENT,
            [WEBHOOK_EVENT_HEADER]: event,
            [WEBHOOK_DELIVERY_HEADER]: run.id,
            [WEBHOOK_SIGNATURE_HEADER]: signature,
          },
          body,
          signal: controller.signal,
          // A webhook target is a user-supplied URL; never carry credentials
          // across origins and never follow a redirect to somewhere private.
          redirect: 'error',
          cache: 'no-store',
        });

        if (!response.ok) {
          logger.warn('Webhook rejected', { status: response.status, event });
        } else {
          logger.debug('Webhook delivered', { event });
        }
      } catch (error) {
        logger.warn('Webhook delivery failed', { event, reason: (error as Error).name });
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Reference verifier for receivers — exported so it can be unit-tested and documented. */
export function verifyWebhookSignature(header: string | null, body: string, secret: string): boolean {
  if (!header) return false;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  // Reject anything outside the replay window before doing any HMAC work.
  if (Math.abs(Math.floor(Date.now() / 1000) - parsed.timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;

  return safeEqual(signPayload(body, secret, parsed.timestamp), header);
}
