/**
 * The webhook contract, shared by the web app (inline delivery) and the worker
 * (durable delivery with retries).
 *
 * A receiver must see exactly the same payload, headers and signature no matter
 * which process happened to send it. When this lived in two places, the worker's
 * retry path and the inline path could disagree on a field name and the only
 * symptom would be a receiver that occasionally failed to parse a delivery.
 */
import { AppError } from './errors.js';
import type { Job, JobRun } from './types.js';

export const WEBHOOK_EVENT_HEADER = 'x-webscraper-event';
export const WEBHOOK_DELIVERY_HEADER = 'x-webscraper-delivery';
export const WEBHOOK_SIGNATURE_HEADER = 'x-webscraper-signature';

/** How far a receiver may be from our clock before a signature is stale. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

export const WEBHOOK_USER_AGENT = 'Webscraper-Webhook/1.0';

/** The event name for a finished run. */
export function eventForRunStatus(status: JobRun['status']): string {
  switch (status) {
    case 'succeeded':
      return 'run.succeeded';
    case 'partial':
      return 'run.partial';
    case 'failed':
    case 'timeout':
      return 'run.failed';
    case 'cancelled':
      return 'run.cancelled';
    default:
      return 'run.started';
  }
}

/** `t=<unix>,v1=<hex>` — the shape receivers parse. Kept in one place. */
export function formatSignatureHeader(timestampSeconds: number, hex: string): string {
  return `t=${timestampSeconds},v1=${hex}`;
}

export function parseSignatureHeader(header: string): { timestamp: number; signature: string } | null {
  const parts = new Map(
    header
      .split(',')
      .map((chunk) => chunk.trim().split('=', 2))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!signature || !Number.isFinite(timestamp)) return null;
  return { timestamp, signature };
}

/**
 * Hosts we will never deliver to.
 *
 * A webhook URL is an outbound request that *we* make, on demand, from inside
 * our own network — the textbook definition of SSRF. The engine's guard is not
 * reused here because webhook delivery does not go through the engine, so the
 * policy has to exist on this side too.
 *
 * Checked twice on purpose: once when the URL is saved (fast feedback in the
 * form) and again immediately before every delivery, because a hostname that
 * resolved to a public address yesterday can resolve to 169.254.169.254 today.
 * A full defence needs resolve-then-pin (what the Python engine does); for
 * webhooks, refusing private literals plus `redirect: 'error'` closes the
 * practical paths.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique-local IPv6
  /^\[?fe80:/i, // link-local IPv6
  /^\[?::ffff:(127|10|192\.168|169\.254)\./i,
];

export const WEBHOOK_ALLOWED_PORTS = ['443', '8443'] as const;

/** Validate a webhook URL, throwing a typed 422 a form can render inline. */
export function assertWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError({ code: 'invalid_config', message: 'That is not a valid URL.', details: { field: 'url' } });
  }

  if (url.protocol !== 'https:') {
    throw new AppError({
      code: 'invalid_config',
      message: 'Webhook endpoints must use HTTPS: the payload can contain scraped data.',
      details: { field: 'url' },
    });
  }
  if (url.username || url.password) {
    throw new AppError({
      code: 'invalid_config',
      message: 'Remove the credentials from the URL — we sign every delivery instead.',
      details: { field: 'url' },
    });
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new AppError({
      code: 'invalid_config',
      message: 'That host is on a private or loopback network, so we will not deliver webhooks to it.',
      details: { field: 'url' },
    });
  }
  if (url.port && !WEBHOOK_ALLOWED_PORTS.includes(url.port as (typeof WEBHOOK_ALLOWED_PORTS)[number])) {
    throw new AppError({
      code: 'invalid_config',
      message: `Only ports ${WEBHOOK_ALLOWED_PORTS.join(' and ')} are allowed for webhook endpoints.`,
      details: { field: 'url' },
    });
  }

  return url;
}

export interface WebhookPayload {
  event: string;
  deliveredAt: string;
  data: {
    job: { id: string; name: string; mode: string; targets: string[]; tags: string[] };
    run: {
      id: string;
      number: number;
      status: string;
      trigger: string;
      startedAt: string | null;
      finishedAt: string | null;
      durationMs: number | null;
      pagesOk: number;
      pagesFailed: number;
      pagesTotal: number;
      recordsNew: number;
      recordsChanged: number;
      errorCode: string | null;
      errorMessage: string | null;
    };
    links: { job: string; run: string };
  };
}

/**
 * The payload body.
 *
 * Deliberately includes no scraped records. A webhook is a *notification*; the
 * consumer fetches the data through the API with its own key and scopes. Pushing
 * full datasets into a third-party endpoint turns every integration into an
 * uncontrolled copy of the tenant's data.
 */
export function buildWebhookPayload(input: { event: string; job: Job; run: JobRun; appUrl: string }): WebhookPayload {
  const { event, job, run, appUrl } = input;
  return {
    event,
    deliveredAt: new Date().toISOString(),
    data: {
      job: {
        id: job.id,
        name: job.name,
        mode: job.mode,
        targets: job.config.targets,
        tags: job.tags,
      },
      run: {
        id: run.id,
        number: run.run_number,
        status: run.status,
        trigger: run.trigger,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        durationMs: run.duration_ms,
        pagesOk: run.pages_ok,
        pagesFailed: run.pages_failed,
        pagesTotal: run.pages_total,
        recordsNew: run.records_new,
        recordsChanged: run.records_changed,
        errorCode: run.error_code,
        errorMessage: run.error_message,
      },
      links: {
        job: `${appUrl}/jobs/${job.id}`,
        run: `${appUrl}/jobs/${job.id}?run=${run.id}`,
      },
    },
  };
}
