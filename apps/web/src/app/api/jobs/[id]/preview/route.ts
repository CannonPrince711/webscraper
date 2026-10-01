import {
  errors,
  safeParseScrapeConfig,
  type ExtractFieldSuggestion,
  type ScrapeConfig,
} from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { engine } from '@/lib/engine';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * "Show me what this would scrape, before I run it."
 *
 * The preview fetches exactly one page and extracts from it without writing a
 * single row. That constraint is the whole design:
 *
 *  - **One page, always.** A preview that follows links is a crawl, and a user
 *    clicking "Preview" five times while tuning selectors would send five
 *    crawls at someone's server.
 *  - **Nothing is persisted.** No page rows, no records, no usage events —
 *    otherwise every keystroke in the wizard would pollute the dataset.
 *  - **The engine does the fetching**, so the SSRF guard and robots.txt rules
 *    apply to previews exactly as they do to real runs. A preview endpoint that
 *    skipped those checks would be a first-class SSRF hole.
 *  - **Selectors can be probed directly** (mode 2), which is what powers the
 *    field mapper: type a CSS selector, see the first few matches, no guessing.
 */

const selectorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  selector: z.string().trim().min(1).max(500),
  selectorType: z.enum(['css', 'xpath']).default('css'),
  attribute: z.string().trim().max(80).nullable().optional(),
});

const schema = z.object({
  url: z.string().trim().min(4).max(2048).optional(),
  /** A draft config from the wizard; falls back to the saved job config. */
  draftConfig: z.unknown().optional(),
  /** Pre-fetched HTML from the editor — avoids a second network request. */
  html: z.string().max(4_000_000).optional(),
  /** When present, probe these selectors instead of running extraction. */
  selectors: z.array(selectorSchema).min(1).max(40).optional(),
  sampleLimit: z.number().int().min(1).max(10).default(3),
});

export const POST = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  await enforceRateLimit(`preview:${orgContext.org.id}`, { max: 60, windowMs: 60_000 });

  const job = await store.getJob(id);
  if (!job) throw errors.notFound('Job');

  const parsed = schema.safeParse(await readJson(request, 5_000_000));
  if (!parsed.success) throw fromZod(parsed.error);

  const url = parsed.data.url ?? job.config.targets[0];
  if (!url) throw errors.invalidConfig('Add a target URL to this job, or pass one to preview.');

  // --- mode 2: selector probing -------------------------------------------
  if (parsed.data.selectors) {
    let html = parsed.data.html ?? '';
    let resolvedUrl = url;

    if (!html) {
      const fetched = await fetchOne({ url, config: job.config });
      if (fetched.status !== 'ok' || !fetched.html) {
        return jsonOk({
          ok: false,
          url,
          errorCode: fetched.errorCode ?? 'fetch_failed',
          errorMessage: fetched.errorMessage ?? 'The page could not be fetched, so selectors cannot be tested.',
          probes: [],
        });
      }
      html = fetched.html;
      resolvedUrl = fetched.finalUrl;
    }

    const probes = await engine.previewSelectors({
      html,
      url: resolvedUrl,
      selectors: parsed.data.selectors.map((selector) => ({
        name: selector.name,
        selector: selector.selector,
        selectorType: selector.selectorType,
        attribute: selector.attribute ?? null,
      })),
      sampleLimit: parsed.data.sampleLimit,
    });

    return jsonOk({ ok: true, url: resolvedUrl, probes });
  }

  // --- mode 1: full extraction preview ------------------------------------
  let config = job.config;
  if (parsed.data.draftConfig) {
    const validated = safeParseScrapeConfig(parsed.data.draftConfig);
    if (!validated.success) {
      throw errors.invalidConfig(
        'The draft configuration is not valid yet.',
        {
          problems: validated.error.issues.slice(0, 8).map((issue) => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        },
      );
    }
    config = validated.data;
  }

  const outcome = parsed.data.html
    ? await engine.extractFromHtml({ html: parsed.data.html, url, config })
    : null;

  if (outcome) {
    return jsonOk({
      ok: outcome.status === 'ok' || outcome.status === 'partial',
      url,
      htmlProvided: true,
      records: outcome.records.slice(0, 25),
      recordConfidences: outcome.confidences.slice(0, 25),
      extraction: outcome.extraction,
      warnings: outcome.warnings,
      durationMs: outcome.durationMs,
    });
  }

  const page = await fetchOne({ url, config });

  return jsonOk({
    ok: page.status === 'ok',
    url,
    finalUrl: page.finalUrl,
    status: page.status,
    httpStatus: page.httpStatus,
    fetchMethod: page.fetchMethod,
    rendered: page.rendered,
    durationMs: page.durationMs,
    bodyBytes: page.bodyBytes,
    errorCode: page.errorCode,
    errorMessage: page.errorMessage,
    page: {
      title: page.title,
      lang: page.lang,
      canonicalUrl: page.canonicalUrl,
      contentHash: page.contentHash,
      headings: page.headings.slice(0, 20),
      linkCount: page.links.length,
      jsonLdTypes: (page.jsonLd ?? [])
        .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['@type'] : null))
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 10),
      textPreview: page.text ? page.text.slice(0, 1_500) : null,
      markdownPreview: page.markdown ? page.markdown.slice(0, 1_500) : null,
      htmlBytes: page.html ? page.html.length : 0,
    },
    records: page.records.slice(0, 25),
    recordConfidences: page.recordConfidences.slice(0, 25),
    extraction: page.extraction,
    warnings: page.warnings,
    // The engine tells us what it *would* have used for auto extraction; the
    // wizard turns that into one-click field definitions. `extraction` is an
    // open diagnostics bag, so the shape is narrowed here, once.
    suggestedFields: suggestionsOf(page.extraction).fields,
    suggestedListSelector: suggestionsOf(page.extraction).listSelector,
  });
});

/**
 * The subset of an engine page result the preview needs.
 *
 * Declared explicitly rather than inferred from the SDK type so the shape the
 * UI depends on is visible in one place — and so a change in the engine's
 * payload becomes a compile error here instead of `undefined` in the browser.
 */
interface PreviewPage {
  status: string;
  finalUrl: string;
  httpStatus: number | null;
  fetchMethod: 'http' | 'browser';
  rendered: boolean;
  durationMs: number;
  bodyBytes: number;
  title: string | null;
  lang: string | null;
  canonicalUrl: string | null;
  contentHash: string | null;
  headings: Array<{ level: string; text: string }>;
  links: Array<{ url: string; normalizedUrl: string; text: string; rel: string[]; nofollow: boolean; isPagination: boolean }>;
  jsonLd: unknown[];
  text: string | null;
  markdown: string | null;
  html: string | null;
  records: Array<Record<string, unknown>>;
  recordConfidences: number[];
  extraction: Record<string, unknown>;
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Fetch exactly one page through the engine, using the job's fetch settings but
 * hard-capped to a single page, a shorter deadline and a smaller byte budget.
 *
 * The cap is not a suggestion: the engine reads the same `limits` block, and
 * `mode: 'single'` with `maxDepth: 0` means a misconfigured crawl job cannot
 * turn a preview click into a site walk.
 */
async function fetchOne(input: { url: string; config: ScrapeConfig }): Promise<PreviewPage> {
  const config: ScrapeConfig = {
    ...input.config,
    mode: 'single',
    targets: [input.url],
    crawl: { ...input.config.crawl, maxDepth: 0, maxPages: 1, sameDomain: true, useSitemap: false },
    limits: {
      ...input.config.limits,
      maxPages: 1,
      maxDurationMs: Math.min(input.config.limits.maxDurationMs, 90_000),
      maxBytesPerPage: Math.min(input.config.limits.maxBytesPerPage, 10_000_000),
    },
    fetch: { ...input.config.fetch, saveHtml: true, screenshot: false },
  };

  const response = await engine.scrape(
    { config, urls: [input.url], depth: 0, includeHtml: true },
    { timeoutMs: 120_000 },
  );

  const result = response.results[0];
  if (!result) {
    return {
      status: 'fetch_failed',
      finalUrl: input.url,
      httpStatus: null,
      fetchMethod: 'http',
      rendered: false,
      durationMs: 0,
      bodyBytes: 0,
      title: null,
      lang: null,
      canonicalUrl: null,
      contentHash: null,
      headings: [],
      links: [],
      jsonLd: [],
      text: null,
      markdown: null,
      html: null,
      records: [],
      recordConfidences: [],
      extraction: {},
      warnings: ['The engine returned no result for that URL.'],
      errorCode: 'fetch_failed',
      errorMessage: 'The engine returned no result for that URL.',
    };
  }

  return {
    // The engine reports `ok`/`not_modified` for successes and a failure code
    // otherwise; normalise to a string the UI can switch on.
    status: result.status,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    fetchMethod: result.fetchMethod,
    rendered: result.rendered,
    durationMs: result.durationMs,
    bodyBytes: result.bodyBytes,
    title: result.title,
    lang: result.lang,
    canonicalUrl: result.canonicalUrl,
    contentHash: result.contentHash,
    headings: result.headings ?? [],
    links: result.links ?? [],
    jsonLd: (result.jsonLd ?? []) as unknown[],
    text: result.text ?? null,
    markdown: result.markdown ?? null,
    html: result.html ?? null,
    records: result.records ?? [],
    recordConfidences: result.recordConfidences ?? [],
    extraction: (result.extraction ?? {}) as Record<string, unknown>,
    warnings: result.warnings ?? [],
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
  };
}

/** Narrow the engine's diagnostics bag to the auto-extraction suggestion. */
function suggestionsOf(extraction: Record<string, unknown>): {
  fields: ExtractFieldSuggestion[];
  listSelector: string | null;
} {
  const suggested = extraction['suggestedConfig'] as
    | { fields?: ExtractFieldSuggestion[]; listSelector?: string | null }
    | undefined;
  return {
    fields: Array.isArray(suggested?.fields) ? suggested.fields : [],
    listSelector: suggested?.listSelector ?? null,
  };
}
