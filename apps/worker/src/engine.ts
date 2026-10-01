import { AppError, type EngineScrapeResponse, type ScrapeConfig, type Json } from '@webscraper/shared';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Client for the Python scraping engine.
 *
 * Three rules, the same ones the web app's client follows — the worker just has
 * stricter retry semantics because it is allowed to take its time:
 *
 *  1. **Every call is deadline-bounded.** A hung engine must not hold a worker
 *     slot forever; the process has a fixed concurrency, so one stuck call
 *     eventually starves every tenant.
 *  2. **Errors are translated, never forwarded.** Raw engine bodies can contain
 *     internal hostnames; only `AppError.code` escapes.
 *  3. **Retries are for transport failures only.** A page that returned 404 is a
 *     result, not an error, and the pipeline already recorded it as such.
 */

const ENGINE_TIMEOUT_MS = env.ENGINE_TIMEOUT_MS;

export interface EngineScrapeRequest {
  config: ScrapeConfig;
  urls?: string[];
  depth?: number;
  includeHtml?: boolean;
  deadlineMs?: number;
  requestId?: string;
}

async function request<T>(path: string, body: unknown, timeoutMs = ENGINE_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${env.ENGINE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ENGINE_API_KEY}`,
        'content-type': 'application/json',
        'user-agent': 'webscraper-worker/0.1',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let code = 'engine_error';
      let message = `The engine returned HTTP ${response.status}.`;
      let retryable = response.status >= 500 || response.status === 429;
      try {
        const payload = (await response.json()) as { error?: { code?: string; message?: string } };
        if (payload.error?.code) code = payload.error.code;
        if (payload.error?.message) message = payload.error.message;
      } catch {
        // A proxy answered; keep the generic message.
      }
      throw new AppError({
        code: code === 'ssrf_blocked' ? 'ssrf_blocked' : code === 'robots_disallowed' ? 'robots_disallowed' : 'engine_error',
        message,
        retryable,
        internal: `engine responded ${response.status}`,
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new AppError({
      code: aborted ? 'engine_error' : 'engine_unavailable',
      message: aborted ? 'The engine took too long to respond.' : 'The engine could not be reached.',
      retryable: true,
      internal: aborted ? 'worker request aborted on timeout' : 'network failure',
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const engine = {
  /**
   * Liveness probe for the worker's own health endpoint.
   *
   * Deliberately not part of `request`: `/readyz` is a GET with no body, and
   * bending the POST helper to cover it would produce a request with a literal
   * `undefined` body — a bug that only shows up when someone reads the logs.
   */
  async ready(): Promise<boolean> {
    try {
      const response = await fetch(`${env.ENGINE_URL}/readyz`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.ENGINE_API_KEY}` },
        signal: AbortSignal.timeout(4_000),
        });
      return response.ok;
    } catch {
      return false;
    }
  },

  /** One crawl batch: fetch, parse and extract a set of URLs at the same depth. */
  scrape(payload: EngineScrapeRequest): Promise<EngineScrapeResponse> {
    return request<EngineScrapeResponse>('/v1/scrape', payload, ENGINE_TIMEOUT_MS);
  },

  /** LLM enrichment for up to 100 records at a time. */
  enrich(payload: {
    records: Array<Record<string, Json>>;
    tasks: string[];
    labels: string[];
    instructions?: string | null;
    model?: string | null;
  }): Promise<{
    results: Array<Record<string, Json>>;
    usage: { totalTokens: number; costUsd: number; model?: string };
  }> {
    return request('/v1/ai/enrich', payload, 180_000);
  },
};

/**
 * Retry a transport-level failure with exponential backoff.
 *
 * Only `retryable` AppErrors are retried, and only for calls that are safe to
 * repeat — every engine endpoint here is a pure read/compute, so a duplicate is
 * harmless (records are deduped by content hash anyway).
 */
export async function withRetry<T>(operation: () => Promise<T>, attempts = 3, baseDelayMs = 1_500): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AppError && error.retryable;
      if (!retryable || attempt === attempts) throw error;

      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn('Engine call failed; retrying', {
        attempt,
        attempts,
        delayMs: delay,
        code: error instanceof AppError ? error.code : 'unknown',
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
