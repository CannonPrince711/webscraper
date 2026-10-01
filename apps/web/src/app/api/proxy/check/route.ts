import { errors } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { engine } from '@/lib/engine';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Proxy self-test.
 *
 * Rate-limited and editor-gated on purpose: every call spends the org's proxy
 * bandwidth and exits from a paid IP, so a viewer — or a script with a viewer
 * key — must not be able to fire it in a loop.
 */

const schema = z.object({
  // The same policy string a job stores: 'decodo', 'decodo://?country=us', an
  // explicit proxy URL, or null for the engine default.
  policy: z.string().trim().max(500).nullable().default(null),
});

export const POST = route(async (request) => {
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer') throw errors.forbidden('Viewers cannot run a proxy check.');

  await enforceRateLimit(`proxy-check:${orgContext.org.id}`, { max: 20, windowMs: 60_000 });

  const parsed = schema.safeParse(await readJson(request).catch(() => ({})));
  if (!parsed.success) throw fromZod(parsed.error);

  // The engine answers with a result object rather than an error status: a
  // wrong credential is a diagnosis, not a fault.
  return jsonOk(await engine.checkProxy(parsed.data.policy));
});
