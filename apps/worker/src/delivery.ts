import { createHmac } from 'node:crypto';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_USER_AGENT,
  assertWebhookUrl,
  buildWebhookPayload,
  eventForRunStatus,
  formatSignatureHeader,
  type Job,
  type JobRun,
} from '@webscraper/shared';
import { supabase, webhookTargets, type WebhookTarget } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Webhook delivery with a ledger.
 *
 * The web app also delivers webhooks inline (so a demo instance with no worker
 * still integrates with something), but the worker is where delivery is
 * *durable*: every attempt is written to `webhook_deliveries` before the request
 * goes out, and failures are retried by the `deliver` queue with exponential
 * backoff.
 *
 * Three decisions:
 *  - **The ledger row comes first.** A crash between "sent" and "recorded" would
 *    otherwise lose the delivery with no trace, and the receiver's own logs
 *    would be the only evidence.
 *  - **A 4xx is not retried** (except 408/429). Retrying a 401 five times just
 *    hammers a receiver that has already told us the signature or the URL is
 *    wrong. That is a permanent failure with an actionable message.
 *  - **The payload carries no records** — see `buildWebhookPayload` in shared.
 */

const DELIVERY_TIMEOUT_MS = 10_000;

export function signWebhookBody(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return formatSignatureHeader(timestamp, mac);
}

export interface DeliveryOutcome {
  ok: boolean;
  status: number | null;
  snippet: string | null;
  /** False when the failure is permanent and retrying would be pointless. */
  retryable: boolean;
  error: string | null;
}

/** One HTTP attempt. Never throws: the outcome is the return value. */
export async function attemptDelivery(input: { url: string; secret: string; body: string; event: string; deliveryId: string }): Promise<DeliveryOutcome> {
  try {
    assertWebhookUrl(input.url);
  } catch (error) {
    return { ok: false, status: null, snippet: null, retryable: false, error: (error as Error).message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': WEBHOOK_USER_AGENT,
        [WEBHOOK_EVENT_HEADER]: input.event,
        [WEBHOOK_DELIVERY_HEADER]: input.deliveryId,
        // Signed over `"{t}.{body}"`; the timestamp is inside the signed payload
        // so a captured request cannot be replayed once the window closes.
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(input.body, input.secret),
      },
      body: input.body,
      // A user-supplied URL must never be followed elsewhere — a redirect to
      // 169.254.169.254 is the classic way to turn a webhook into SSRF.
      redirect: 'error',
      signal: controller.signal,
    });

    const snippet = (await response.text().catch(() => '')).slice(0, 500);
    const retryable = response.status >= 500 || response.status === 429 || response.status === 408;

    return {
      ok: response.ok,
      status: response.status,
      snippet: snippet || null,
      retryable,
      error: response.ok ? null : `The endpoint answered ${response.status}.`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      status: null,
      snippet: null,
      retryable: true,
      error: aborted ? 'The endpoint did not answer within 10 seconds.' : 'The endpoint could not be reached.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create ledger rows for every endpoint subscribed to this event and make the
 * first attempt. Returns the ids that still need retrying.
 */
export async function notifyRunEvent(input: { job: Job; run: JobRun; orgId: string }): Promise<string[]> {
  const event = eventForRunStatus(input.run.status);
  const targets = (await webhookTargets(input.orgId)).filter(
    (target) => target.events.includes(event) || target.events.includes('*'),
  );
  if (targets.length === 0) return [];

  const payload = buildWebhookPayload({ event, job: input.job, run: input.run, appUrl: env.APP_URL });
  const body = JSON.stringify(payload);
  const retryIds: string[] = [];

  for (const target of targets) {
    const deliveryId = await openDelivery(input.orgId, target, event, payload);
    if (!deliveryId) continue;

    const outcome = await attemptDelivery({ url: target.url, secret: target.secret, body, event, deliveryId });
    await recordAttempt(deliveryId, outcome, 1);

    if (!outcome.ok && outcome.retryable) retryIds.push(deliveryId);
    if (outcome.ok) {
      logger.info('Webhook delivered', { deliveryId, event });
    } else {
      logger.warn('Webhook failed', { deliveryId, event, status: outcome.status, retryable: outcome.retryable });
    }
  }

  return retryIds;
}

async function openDelivery(orgId: string, target: WebhookTarget, event: string, payload: unknown): Promise<string | null> {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .insert({ org_id: orgId, webhook_id: target.id, event, payload, status: 'pending', attempts: 0 })
    .select('id')
    .single();

  if (error || !data) {
    logger.warn('Could not open a webhook delivery row', { code: error?.code });
    return null;
  }
  return (data as { id: string }).id;
}

async function recordAttempt(deliveryId: string, outcome: DeliveryOutcome, attempts: number): Promise<void> {
  const { error } = await supabase
    .from('webhook_deliveries')
    .update({
      status: outcome.ok ? 'delivered' : attempts >= env.WEBHOOK_MAX_ATTEMPTS ? 'dead' : 'failed',
      attempts,
      response_status: outcome.status,
      response_snippet: outcome.snippet,
      delivered_at: outcome.ok ? new Date().toISOString() : null,
      next_attempt_at: new Date(Date.now() + Math.min(3_600_000, 2 ** attempts * 5_000)).toISOString(),
    })
    .eq('id', deliveryId);
  if (error) logger.warn('Could not record a delivery attempt', { deliveryId, code: error.code });
}

/** Retry one ledger row. Used by the `deliver` queue. */
export async function retryDelivery(deliveryId: string): Promise<{ ok: boolean; attempts: number }> {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .select('id, org_id, webhook_id, event, payload, attempts, webhooks(url, signing_secret, is_active)')
    .eq('id', deliveryId)
    .maybeSingle();

  if (error || !data) {
    logger.warn('Delivery row disappeared; dropping the retry', { deliveryId, code: error?.code });
    return { ok: false, attempts: 0 };
  }

  const row = data as unknown as {
    id: string;
    event: string;
    payload: unknown;
    attempts: number;
    webhooks: { url: string; signing_secret: string; is_active: boolean } | null;
  };

  if (!row.webhooks?.is_active) {
    await supabase.from('webhook_deliveries').update({ status: 'dead', response_snippet: 'Webhook was disabled.' }).eq('id', deliveryId);
    return { ok: false, attempts: row.attempts };
  }

  const attempts = row.attempts + 1;
  if (attempts > env.WEBHOOK_MAX_ATTEMPTS) {
    await supabase.from('webhook_deliveries').update({ status: 'dead', attempts }).eq('id', deliveryId);
    return { ok: false, attempts };
  }

  const body = JSON.stringify(row.payload);
  const outcome = await attemptDelivery({
    url: row.webhooks.url,
    secret: row.webhooks.signing_secret,
    body,
    event: row.event,
    deliveryId,
  });
  await recordAttempt(deliveryId, outcome, attempts);

  return { ok: outcome.ok, attempts };
}
