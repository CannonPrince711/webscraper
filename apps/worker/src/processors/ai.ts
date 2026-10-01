import { toAppError, type Json } from '@webscraper/shared';
import { supabase, recordUsage } from '../db.js';
import { engine, withRetry } from '../engine.js';
import { logger } from '../logger.js';

/**
 * Enrichment worker.
 *
 * Enrichment runs as its own job rather than inline in the crawl for one
 * reason: **the two fail differently.** A scrape that succeeded must keep its
 * data even if the model provider is down, and a model call that is rate-limited
 * needs a retry schedule of its own. Keeping them in one job couples a free
 * operation to a paid, flaky one.
 *
 * AI output is stored in `records.enriched`, never merged into `records.data`:
 * a re-run of enrichment can then replace it wholesale without destroying the
 * deterministic extraction underneath.
 */

export interface EnrichPayload {
  orgId: string;
  jobId: string;
  runId?: string | null;
  /** Enrich exactly these records; when omitted, the whole run is processed. */
  recordIds?: string[];
  tasks: string[];
  labels?: string[];
  instructions?: string | null;
  model?: string | null;
  batchSize?: number;
}

const DEFAULT_BATCH = 25;

export async function processEnrichment(payload: EnrichPayload): Promise<{ enriched: number; tokens: number }> {
  let query = supabase.from('records').select('id, data').eq('org_id', payload.orgId);

  if (payload.recordIds && payload.recordIds.length > 0) {
    query = query.in('id', payload.recordIds.slice(0, 500));
  } else if (payload.runId) {
    query = query.eq('run_id', payload.runId).limit(500);
  } else {
    query = query.eq('job_id', payload.jobId).is('enriched', null).limit(500);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not load records for enrichment: ${error.code}`);

  const rows = (data ?? []) as Array<{ id: string; data: Record<string, Json> }>;
  if (rows.length === 0) return { enriched: 0, tokens: 0 };

  const batchSize = Math.min(payload.batchSize ?? DEFAULT_BATCH, 50);
  let enriched = 0;
  let tokens = 0;
  let costUsd = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize);

    const response = await withRetry(() =>
      engine.enrich({
        records: chunk.map((row) => row.data),
        tasks: payload.tasks,
        labels: payload.labels ?? [],
        instructions: payload.instructions ?? null,
        model: payload.model ?? null,
      }),
    );

    tokens += response.usage?.totalTokens ?? 0;
    costUsd += response.usage?.costUsd ?? 0;

    for (const [index, row] of chunk.entries()) {
      const enrichment = response.results?.[index];
      if (!enrichment) continue;
      const { error: updateError } = await supabase.from('records').update({ enriched: enrichment }).eq('id', row.id);
      if (!updateError) enriched += 1;
    }
  }

  await recordUsage({
    orgId: payload.orgId,
    kind: 'ai_tokens',
    quantity: tokens,
    unitCostUsd: costUsd,
    jobId: payload.jobId,
    runId: payload.runId ?? null,
    metadata: { tasks: payload.tasks },
  });

  logger.info('Enrichment finished', { jobId: payload.jobId, enriched, tokens });
  return { enriched, tokens };
}

/** Convenience for callers that only have an org-scoped job. */
export async function safeProcessEnrichment(payload: EnrichPayload): Promise<void> {
  try {
    await processEnrichment(payload);
  } catch (error) {
    const appError = toAppError(error);
    // Enrichment is additive; losing it must not lose scraped data.
    logger.warn('Enrichment failed', { code: appError.code, jobId: payload.jobId });
  }
}
