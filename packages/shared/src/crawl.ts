/**
 * The crawl frontier.
 *
 * Written once, as a pure function over an injected `fetchBatch`, so the inline
 * runner (no Redis) and the BullMQ worker (Redis, resumable, distributed)
 * cannot drift apart on the rules that actually matter:
 *
 *   - **De-duplication by normalised URL.** Not by the raw string: `?utm_source=`
 *     and a trailing slash must not create a second node, or the crawl never
 *     converges on sites that link inconsistently.
 *   - **Breadth-first with a hard page ceiling.** Depth is tracked because a
 *     max-pages limit alone can be spent entirely on one deep branch.
 *   - **Scope enforcement before queueing.** Include/exclude globs and
 *     same-domain checks are applied to the *frontier*, not after the fetch, so
 *     a disallowed URL costs nothing.
 *   - **Politeness.** The engine already rate-limits per domain; this loop
 *     additionally bounds batch concurrency so a 5,000-page crawl does not open
 *     5,000 sockets.
 *
 * Deterministic given the same inputs, which is what makes crawl tests
 * meaningful and makes a resumed crawl visit the same pages in the same order.
 */
import type { CrawlSpec, JobMode } from './scrape-config.js';
import { normalizeUrl, pathMatchesAny } from './utils.js';

/**
 * The minimum a page must have to participate in a crawl.
 *
 * Deliberately *not* an index-signature bag: the caller passes its own richer
 * page type (the engine's `EnginePageResult`, which carries records, markdown,
 * hashes and so on) and gets it back untouched. The frontier only ever reads
 * `url`, `finalUrl` and `links`.
 */
export interface CrawlPage {
  url: string;
  finalUrl: string;
  links?: Array<{ url: string; normalizedUrl?: string; nofollow?: boolean; isPagination?: boolean }>;
}

export interface CrawlBatchRequest {
  urls: string[];
  depth: number;
}

export interface CrawlBatchResult<P extends CrawlPage = CrawlPage> {
  results: P[];
  /** The engine's own link discovery — used as a cross-check on our scoping. */
  discovered?: string[];
}

export interface CrawlDeps<P extends CrawlPage = CrawlPage> {
  targets: string[];
  crawl: CrawlSpec;
  mode: JobMode;
  maxPages: number;
  /** One engine call for a set of URLs at the same depth. */
  fetchBatch: (request: CrawlBatchRequest, signal?: AbortSignal) => Promise<CrawlBatchResult<P>>;
  /** Optional host-level admission check (e.g. the engine's SSRF pre-flight). */
  isAllowed?: (url: string) => boolean;
  /** Called after each batch so the caller can persist progress incrementally. */
  onBatch?: (pages: P[]) => Promise<void>;
  signal?: AbortSignal;
}

export interface CrawlOutcome<P extends CrawlPage = CrawlPage> {
  pages: P[];
  visited: string[];
  truncated: boolean;
  depths: Record<string, number>;
  /** URLs the engine reported but we refused: useful telemetry, and it shows
   *  the user why a crawl stopped short. */
  skipped: Array<{ url: string; reason: string }>;
}

/** Which host(s) a crawl may visit, derived from its targets. */
function allowedHosts(targets: string[]): string[] {
  const hosts = new Set<string>();
  for (const target of targets) {
    try {
      const url = new URL(target);
      hosts.add(url.hostname.toLowerCase());
      // A crawl of example.com should also cover www.example.com.
      hosts.add(url.hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      continue;
    }
  }
  return Array.from(hosts);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function inScope(url: string, crawl: CrawlSpec, hosts: string[]): { ok: boolean; reason?: string } {
  const host = hostOf(url);
  if (!host) return { ok: false, reason: 'unparseable_url' };

  if (crawl.sameDomain) {
    const bare = host.replace(/^www\./, '');
    if (!hosts.includes(bare) && !hosts.includes(host)) {
      return { ok: false, reason: 'off_domain' };
    }
  }

  const path = pathOf(url);
  if (crawl.exclude.length > 0 && pathMatchesAny(path, crawl.exclude)) {
    return { ok: false, reason: 'excluded' };
  }
  if (crawl.include.length > 0 && !pathMatchesAny(path, crawl.include)) {
    return { ok: false, reason: 'not_included' };
  }

  return { ok: true };
}

/**
 * Breadth-first crawl.
 *
 * Only `crawl` and `sitemap` modes expand; `single` and `batch` fetch exactly
 * what they were given. That asymmetry is intentional — a user who asked for
 * one page should never get a thousand.
 */
export async function runCrawlLoop<P extends CrawlPage>(deps: CrawlDeps<P>): Promise<CrawlOutcome<P>> {
  const { targets, crawl, mode, maxPages, fetchBatch, onBatch, isAllowed, signal } = deps;
  const pageCeiling = Math.min(maxPages, crawl.maxPages);
  const hosts = allowedHosts(targets);

  const visited = new Set<string>();
  const depths: Record<string, number> = {};
  const pages: P[] = [];
  const skipped: CrawlOutcome<P>['skipped'] = [];
  let truncated = false;

  const expansionsEnabled = mode === 'crawl' || mode === 'sitemap';
  const maxDepth = expansionsEnabled ? crawl.maxDepth : 0;

  // Seed the frontier with the normalised targets, preserving order.
  let frontier: Array<{ url: string; depth: number }> = [];
  for (const target of targets) {
    const normalized = normalizeUrl(target);
    if (normalized && !visited.has(normalized)) {
      frontier.push({ url: target, depth: 0 });
      visited.add(normalized);
    }
  }

  let depth = 0;
  while (frontier.length > 0) {
    if (signal?.aborted) break;

    const current = frontier;
    frontier = [];

    // Fetch in bounded batches; concurrency inside the engine is separate.
    for (let offset = 0; offset < current.length; offset += crawl.concurrency) {
      if (signal?.aborted) break;

      const slice = current.slice(offset, offset + crawl.concurrency);
      const remaining = pageCeiling - pages.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const batch = slice.slice(0, remaining);

      const admitted: string[] = [];
      for (const item of batch) {
        if (isAllowed && !isAllowed(item.url)) {
          skipped.push({ url: item.url, reason: 'blocked_by_policy' });
          continue;
        }
        admitted.push(item.url);
      }
      if (admitted.length === 0) continue;

      const result = await fetchBatch({ urls: admitted, depth }, signal);
      const batchPages = result.results ?? [];
      pages.push(...batchPages);
      for (const page of batchPages) {
        depths[normalizeUrl(page.finalUrl || page.url)] = depth;
      }
      if (onBatch && batchPages.length > 0) {
        await onBatch(batchPages);
      }

      // --- expand -----------------------------------------------------
      if (depth < maxDepth) {
        for (const page of batchPages) {
          for (const link of page.links ?? []) {
            const candidate = link.normalizedUrl ?? link.url;
            if (!candidate) continue;

            // rel=nofollow is a request not to follow; honour it unless the
            // user explicitly opted out.
            if (link.nofollow && !crawl.followNofollow) continue;

            const normalized = normalizeUrl(link.url);
            if (!normalized || visited.has(normalized)) continue;

            const scope = inScope(link.url, crawl, hosts);
            if (!scope.ok) {
              if (scope.reason !== 'off_domain') {
                skipped.push({ url: link.url, reason: scope.reason ?? 'out_of_scope' });
              }
              continue;
            }

            visited.add(normalized);
            frontier.push({ url: link.url, depth: depth + 1 });
          }
        }
      }

      if (pages.length >= pageCeiling) {
        truncated = true;
        break;
      }

      // Politeness floor on top of the engine's per-domain rate limit.
      if (crawl.delayMs > 0 && offset + crawl.concurrency < current.length) {
        await new Promise((resolve) => setTimeout(resolve, crawl.delayMs));
      }
    }

    depth += 1;
    if (depth > maxDepth) break;
    if (pages.length >= pageCeiling) {
      truncated = true;
      break;
    }
  }

  return {
    pages,
    visited: Array.from(visited),
    truncated,
    depths,
    skipped: skipped.slice(0, 200),
  };
}
