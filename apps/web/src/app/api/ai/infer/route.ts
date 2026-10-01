import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { engine } from '@/lib/engine';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Infer a schema and selectors for a page.
 *
 * Works with **or without** an AI provider: the engine falls back to structural
 * detection, which is free and deterministic. The UI uses the `configured`
 * flag to explain which path produced the suggestion, so a user never thinks
 * they are looking at AI output when they are looking at heuristics.
 */
const schema = z.object({
  url: z.string().trim().min(4).max(2048).optional(),
  html: z.string().max(4_000_000).optional(),
  instructions: z.string().trim().max(2000).optional(),
});

export const POST = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();
  await enforceRateLimit(`ai:infer:${context.org.id}`, { max: 30, windowMs: 60_000 });

  const parsed = schema.safeParse(await readJson(request, 5_000_000));
  if (!parsed.success) throw fromZod(parsed.error);
  if (!parsed.data.url && !parsed.data.html) {
    throw fromZod(
      new z.ZodError([{ code: 'custom', path: ['url'], message: 'Provide a URL or some HTML to inspect' }]),
    );
  }

  let result: Awaited<ReturnType<typeof engine.inferSchema>>;
  try {
    result = await engine.inferSchema({
      url: parsed.data.url,
      html: parsed.data.html,
      instructions: parsed.data.instructions,
    });
  } catch {
    // The visual picker must still work when the engine is unreachable: the
    // user can define fields by hand. Returning a typed empty result is more
    // useful to the UI than a thrown error.
    return jsonOk({ configured: false, unavailable: true, fields: [], listSelector: null, recordCount: 0 });
  }

  if (result.usage?.totalTokens) {
    await store.recordUsage({
      kind: 'ai_tokens',
      quantity: result.usage.totalTokens,
      unitCostUsd: result.usage.costUsd,
      metadata: { feature: 'schema_inference', model: result.usage.model },
    });
  }

  return jsonOk({
    configured: result.configured,
    listSelector: result.listSelector ?? result.fallback?.listSelector ?? null,
    fields: result.fields ?? result.fallback?.fields ?? [],
    recordCount: result.recordCount ?? result.fallback?.recordCount ?? 0,
    schema: result.schema ?? null,
    usage: result.usage ?? null,
  });
});
