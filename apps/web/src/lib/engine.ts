import 'server-only';
import {
  AppError,
  toAppError,
  type EngineHealth,
  type EngineProxyCheck,
  type EngineScrapeResponse,
  type ScrapeConfig,
  type SelectorProbeResult,
} from '@webscraper/shared';
import { env } from './env';
import { logger } from './logger';

/**
 * Client for the Python scraping engine.
 *
 * Three details that matter more than they look:
 *
 * 1. **Timeouts are mandatory.** A scrape can legitimately take minutes, so the
 *    caller supplies a deadline; without one, a hung engine would hold a Node
 *    request open until the platform kills it.
 * 2. **Errors are translated, never forwarded.** The engine returns a typed
 *    envelope; anything else (an HTML error page from a proxy, a connection
 *    reset) becomes a generic `engine_unavailable`. A raw engine body must never
 *    reach a user, because it can contain internal hostnames.
 * 3. **A circuit breaker.** If the engine is down, failing every request after a
 *    full timeout turns one outage into a request queue pile-up. After a few
 *    consecutive failures, calls fail fast for a cool-down period.
 */

interface EngineCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      // Half-open: let the next call through to probe recovery.
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = Date.now();
  }

  snapshot(): { failures: number; open: boolean } {
    return { failures: this.failures, open: this.isOpen };
  }
}

const breaker = new CircuitBreaker();

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.ENGINE_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'webscraper-web/0.1',
  };
}

/** Translate an engine error envelope into an AppError, or throw a generic one. */
async function translateError(response: Response): Promise<never> {
  let code = 'engine_error';
  let message = `The scraping engine returned HTTP ${response.status}.`;
  let retryable = response.status >= 500;

  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    if (typeof body.error?.retryable === 'boolean') retryable = body.error.retryable;
  } catch {
    // Not JSON: a proxy or load balancer answered. Keep the generic message.
  }

  throw new AppError({
    code: code === 'ssrf_blocked' ? 'ssrf_blocked' : code === 'robots_disallowed' ? 'robots_disallowed' : 'engine_error',
    message,
    retryable,
    internal: `engine responded ${response.status}`,
  });
}

async function call<T>(path: string, init: RequestInit & EngineCallOptions, body?: unknown): Promise<T> {
  if (breaker.isOpen) {
    throw new AppError({
      code: 'engine_unavailable',
      message: 'The scraping engine is temporarily unavailable. Please try again shortly.',
      retryable: true,
    });
  }

  const { timeoutMs = 60_000, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(`${env.ENGINE_URL}${path}`, {
      ...rest,
      headers: { ...authHeaders(), ...(rest.headers as Record<string, string> | undefined) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      breaker.recordFailure();
      return await translateError(response);
    }

    breaker.recordSuccess();
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;

    const aborted = error instanceof Error && error.name === 'AbortError';
    breaker.recordFailure();
    logger.warn('Engine call failed', { path, aborted });

    throw new AppError({
      code: aborted ? 'engine_error' : 'engine_unavailable',
      message: aborted
        ? 'The scraping engine took too long to respond.'
        : 'The scraping engine could not be reached.',
      retryable: true,
      internal: aborted ? 'request aborted on timeout' : 'network failure',
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface EngineScrapeRequest {
  config: ScrapeConfig;
  urls?: string[];
  depth?: number;
  includeHtml?: boolean;
  deadlineMs?: number;
  requestId?: string;
}

export const engine = {
  health(options: EngineCallOptions = {}): Promise<EngineHealth> {
    return call<EngineHealth>('/readyz', { method: 'GET', timeoutMs: 5_000, ...options });
  },

  /** Full pipeline: fetch, parse and extract a batch of URLs. */
  scrape(request: EngineScrapeRequest, options: EngineCallOptions = {}): Promise<EngineScrapeResponse> {
    // A generous ceiling: crawl batches can legitimately take minutes, but the
    // call must still be bounded.
    const timeoutMs = options.timeoutMs ?? Math.min(300_000, (request.deadlineMs ?? 120_000) + 15_000);
    return call<EngineScrapeResponse>('/v1/scrape', { method: 'POST', timeoutMs, signal: options.signal }, request);
  },

  /** Extract from already-fetched HTML — no network round trip to the target. */
  extractFromHtml(request: { html: string; url?: string; config: ScrapeConfig }, options: EngineCallOptions = {}) {
    return call<{
      status: string;
      records: Array<Record<string, unknown>>;
      confidences: number[];
      extraction: Record<string, unknown>;
      suggestedConfig?: { listSelector: string | null; fields: Array<{ name: string; selector: string; type: string }> } | null;
      warnings: string[];
      durationMs: number;
    }>('/v1/extract', { method: 'POST', timeoutMs: options.timeoutMs ?? 45_000 }, request);
  },

  /** Test selectors against a page — powers the visual picker. */
  previewSelectors(
    request: {
      html?: string;
      url?: string;
      selectors: Array<{ name: string; selector: string; selectorType?: 'css' | 'xpath'; attribute?: string | null }>;
      sampleLimit?: number;
    },
    options: EngineCallOptions = {},
  ) {
    return call<SelectorProbeResult[]>('/v1/selectors/preview', { method: 'POST', timeoutMs: options.timeoutMs ?? 30_000 }, request);
  },

  /**
   * Route a single request through the proxy and report the exit IP.
   *
   * Used by Settings → "Test connection": the customer-service question for a
   * proxy is always "am I really leaving through it, and from where?".
   */
  checkProxy(policy: string | null, options: EngineCallOptions = {}) {
    return call<EngineProxyCheck>(
      '/v1/proxy/check',
      { method: 'POST', timeoutMs: options.timeoutMs ?? 45_000 },
      { policy },
    );
  },

  /** Validate targets against the egress policy before saving a job. */
  checkTargets(urls: string[], options: EngineCallOptions = {}) {
    return call<{ results: Array<{ url: string; allowed: boolean; reason?: string; code?: string; host?: string; resolvedIps?: string[] }> }>(
      '/v1/ssrf/check',
      { method: 'POST', timeoutMs: options.timeoutMs ?? 10_000 },
      { urls, resolveDns: true },
    );
  },

  checkRobots(urls: string[], options: EngineCallOptions = {}) {
    return call<{ results: Array<{ url: string; allowed: boolean; reason: string; crawlDelay?: number | null; sitemaps?: string[] }> }>(
      '/v1/robots/check',
      { method: 'POST', timeoutMs: options.timeoutMs ?? 15_000 },
      { urls },
    );
  },

  fetchSitemap(url: string, options: EngineCallOptions = {}) {
    return call<{ entries: Array<{ url: string; lastmod: string | null; changefreq: string | null; priority: number | null }>; count: number; sitemapsRead: number; truncated: boolean }>(
      '/v1/sitemap',
      { method: 'POST', timeoutMs: options.timeoutMs ?? 45_000 },
      { url, followNested: true, maxSitemaps: 10, maxUrls: 5000 },
    );
  },

  aiStatus(options: EngineCallOptions = {}) {
    return call<{ configured: boolean; model: string | null; features: Record<string, boolean> }>(
      '/v1/ai/status',
      { method: 'GET', timeoutMs: 5_000, ...options },
    );
  },

  inferSchema(request: { html?: string; url?: string; instructions?: string }, options: EngineCallOptions = {}) {
    return call<{
      configured: boolean;
      schema?: Record<string, unknown>;
      fields?: Array<{ name: string; selector?: string; type: string }>;
      listSelector?: string | null;
      recordCount?: number;
      fallback?: { listSelector: string | null; fields: Array<{ name: string; selector: string; type: string }>; recordCount: number };
      usage?: { model: string; totalTokens: number; costUsd: number };
    }>('/v1/ai/infer-schema', { method: 'POST', timeoutMs: options.timeoutMs ?? 60_000 }, request);
  },

  naturalLanguageConfig(request: { prompt: string; url?: string }, options: EngineCallOptions = {}) {
    return call<{
      config: ScrapeConfig | null;
      rawConfig: unknown;
      valid: boolean;
      validationError: string | null;
      explanation: string | null;
      usage: { model: string; totalTokens: number; costUsd: number };
    }>('/v1/ai/config', { method: 'POST', timeoutMs: options.timeoutMs ?? 60_000 }, request);
  },

  circuitState: () => breaker.snapshot(),
};

/**
 * Health probe used by the dashboard status pill and the health route.
 * Never throws: an unreachable engine is a state to render, not an error.
 */
export async function engineHealthOrNull(): Promise<EngineHealth | null> {
  try {
    return await engine.health();
  } catch (error) {
    logger.debug('Engine health probe failed', { reason: toAppError(error).code });
    return null;
  }
}
