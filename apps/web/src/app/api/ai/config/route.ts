import { AppError, safeParseScrapeConfig } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { engine } from '@/lib/engine';
import { features } from '@/lib/env';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';
import { logger } from '@/lib/logger';

/**
 * Natural language → ScrapeConfig.
 *
 * The model's output is treated as **untrusted input**: it is validated with
 * the same Zod schema a human-written config goes through, and a validation
 * failure returns the errors plus the raw attempt rather than a 500. An LLM is
 * a helpful guesser, not an authority — the schema is the authority.
 */
const schema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  url: z.string().trim().max(2048).optional(),
  includePageContent: z.boolean().default(true),
});

export const POST = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();

  if (!features.ai) {
    throw new AppError({
      code: 'ai_unavailable',
      message: 'No AI provider is configured. You can still build the configuration manually.',
      retryable: false,
    });
  }

  // AI calls cost real money; this is the first line of defence against a loop.
  await enforceRateLimit(`ai:config:${context.org.id}`, { max: 20, windowMs: 60_000 });

  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  const monthlyTokens = await store.aiTokensThisMonth();
  if (monthlyTokens >= context.org.limits.aiTokensPerMonth) {
    throw new AppError({
      code: 'ai_budget_exceeded',
      message: `Your workspace has used its monthly AI budget (${context.org.limits.aiTokensPerMonth.toLocaleString()} tokens). It resets at the start of next month.`,
      retryable: false,
    });
  }

  const result = await engine.naturalLanguageConfig({
    prompt: parsed.data.prompt,
    url: parsed.data.url,
  });

  if (result.usage?.totalTokens) {
    await store.recordUsage({
      kind: 'ai_tokens',
      quantity: result.usage.totalTokens,
      unitCostUsd: result.usage.costUsd,
      metadata: { feature: 'nl_config', model: result.usage.model },
    });
  }

  // Validate the model's proposal against our own contract.
  const validated = result.config ? safeParseScrapeConfig(result.config) : null;
  if (validated && !validated.success) {
    logger.warn('The model produced a config our schema rejects');
    return jsonOk({
      valid: false,
      config: null,
      rawConfig: result.rawConfig,
      explanation: result.explanation,
      problems: validated.error.issues.slice(0, 8).map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      usage: result.usage,
    });
  }

  return jsonOk({
    valid: Boolean(validated?.success),
    config: validated?.success ? validated.data : null,
    rawConfig: result.rawConfig,
    explanation: result.explanation,
    problems: [],
    usage: result.usage,
  });
});
