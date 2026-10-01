/**
 * Webhook delivery: the signature contract and the retry classification.
 *
 * `delivery.ts` imports `env.ts`, which validates its environment at module
 * load and has no demo mode (correctly — it is a background service). The test
 * therefore sets a minimal environment *before* importing it, and never touches
 * Supabase or the network: `attemptDelivery` is pure HTTP behaviour and is
 * exercised with a stubbed `fetch`.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-at-least-20-chars';

type Delivery = typeof import('../src/delivery.js').attemptDelivery;
type Sign = typeof import('../src/delivery.js').signWebhookBody;

let signWebhookBody: Sign;
let attemptDelivery: Delivery;

beforeAll(async () => {
  ({ signWebhookBody, attemptDelivery } = await import('../src/delivery.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TARGET = {
  url: 'https://hooks.example.com/webscraper',
  secret: 'whsec_test_secret',
  body: JSON.stringify({ event: 'run.succeeded', jobId: 'job-1' }),
  event: 'run.succeeded',
  deliveryId: 'delivery-1',
};

function stubFetch(implementation: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return implementation(url, init);
  });
  return calls;
}

describe('signWebhookBody', () => {
  it('signs "{timestamp}.{body}" and formats the documented header', () => {
    const header = signWebhookBody('{"a":1}', 'whsec_abc', 1_700_000_000);
    const expected = createHmac('sha256', 'whsec_abc').update('1700000000.{"a":1}').digest('hex');

    expect(header).toBe(`t=1700000000,v1=${expected}`);
  });

  it('changes with the body, the secret and the timestamp', () => {
    const base = signWebhookBody('{"a":1}', 's', 1);
    expect(signWebhookBody('{"a":2}', 's', 1)).not.toBe(base);
    expect(signWebhookBody('{"a":1}', 's2', 1)).not.toBe(base);
    expect(signWebhookBody('{"a":1}', 's', 2)).not.toBe(base);
  });
});

describe('attemptDelivery', () => {
  it('reports success without retrying', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }));

    const outcome = await attemptDelivery(TARGET);
    expect(outcome).toMatchObject({ ok: true, status: 200, retryable: false, error: null });
  });

  it('sends the event, delivery and signature headers', async () => {
    const calls = stubFetch(async () => new Response('', { status: 200 }));

    await attemptDelivery(TARGET);
    const headers = calls[0]?.init.headers as Record<string, string>;

    expect(headers['x-webscraper-event']).toBe('run.succeeded');
    expect(headers['x-webscraper-delivery']).toBe('delivery-1');
    expect(headers['x-webscraper-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("never follows a redirect — that is the webhook's SSRF escape hatch", async () => {
    const calls = stubFetch(async () => new Response('', { status: 200 }));

    await attemptDelivery(TARGET);
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it.each([500, 502, 503])('retries a %i (the receiver may recover)', async (status) => {
    stubFetch(async () => new Response('boom', { status }));
    expect(await attemptDelivery(TARGET)).toMatchObject({ ok: false, retryable: true, status });
  });

  it.each([429, 408])('retries a %i (explicitly provisional)', async (status) => {
    stubFetch(async () => new Response('', { status }));
    expect(await attemptDelivery(TARGET)).toMatchObject({ ok: false, retryable: true });
  });

  it.each([400, 401, 403, 404, 410])('does not retry a %i — retrying would just hammer the receiver', async (status) => {
    stubFetch(async () => new Response('nope', { status }));
    const outcome = await attemptDelivery(TARGET);
    expect(outcome).toMatchObject({ ok: false, retryable: false, status });
    expect(outcome.error).toContain(String(status));
  });

  it('keeps a snippet of the response for the delivery log', async () => {
    stubFetch(async () => new Response('signature mismatch', { status: 401 }));
    expect((await attemptDelivery(TARGET)).snippet).toBe('signature mismatch');
  });

  it('treats an unreachable endpoint as retryable', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await attemptDelivery(TARGET)).toMatchObject({ ok: false, retryable: true, status: null });
  });

  it('refuses to POST to a blocked address without making the request', async () => {
    const calls = stubFetch(async () => new Response('', { status: 200 }));

    const outcome = await attemptDelivery({ ...TARGET, url: 'http://169.254.169.254/latest/meta-data/' });

    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: false, retryable: false, status: null });
  });
});
