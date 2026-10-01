import { API_KEY_SCOPES, errors } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { generateApiKey } from '@/lib/crypto';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * API keys.
 *
 * The security model, stated once so it cannot drift:
 *
 *  - **The secret is shown exactly once**, in the creation response, and is
 *    never stored. What lives in the database is `sha256(APP_SECRET + secret)`
 *    — a peppered hash, so a leaked database dump still cannot be used to
 *    authenticate, and a rainbow table over the key space does not help.
 *  - **The prefix is display-only.** `wsk_live_9f3a…` is enough for a human to
 *    tell two keys apart in a list and useless to an attacker.
 *  - **Scopes are denylist-checked against the shared tuple**, so a typo like
 *    `job:write` is a 422 rather than a key that silently does nothing.
 *  - **Expiry is optional but offered**: a key that never expires is a key that
 *    is still valid three years after the contractor left.
 */

const createKeySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name you will recognise later').max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'Pick at least one scope').max(API_KEY_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export const GET = route(async () => {
  const store = await getStore();
  await store.getOrgContext();

  // Revoked keys stay in the list, greyed out: "when was this revoked, and by
  // whom" is exactly the question asked during an incident.
  const keys = await store.listApiKeys();
  return jsonOk({ keys, availableScopes: API_KEY_SCOPES });
});

export const POST = route(async (request) => {
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer' || orgContext.role === 'member') {
    throw errors.forbidden('Only owners and admins can create API keys.');
  }

  await enforceRateLimit(`keys:create:${orgContext.org.id}`, { max: 10, windowMs: 60_000 });

  const parsed = createKeySchema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  const { secret, hash, prefix } = generateApiKey();
  const expiresAt =
    parsed.data.expiresInDays === null
      ? null
      : new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString();

  const key = await store.createApiKey({
    name: parsed.data.name,
    scopes: [...parsed.data.scopes],
    hash,
    prefix,
    expiresAt,
  });

  return jsonOk(
    {
      key,
      // The only time this value exists outside the client's clipboard.
      secret,
      warning: 'Copy this key now. It cannot be shown again — only a hash is stored.',
    },
    { status: 201 },
  );
});
