/**
 * The `ScrapeConfig` contract — the single source of truth for every scrape.
 *
 * This module is mirrored by `services/engine/app/models.py`. Both sides
 * validate the same document, so the boundary is enforced in two languages:
 * a UI bug that produces an invalid config fails at the API with a precise
 * message instead of silently scraping the wrong thing.
 *
 * Two invariants that matter:
 *
 *  1. **Limits are ceilings, not suggestions.** The engine clamps to its own
 *     hard maximum regardless of what we send, so a compromised client cannot
 *     ask for a 500,000-page crawl.
 *  2. **No field name can become a prototype-pollution key.** `__proto__`,
 *     `constructor` and friends are rejected here as well as in Pydantic,
 *     because records get spread into objects all over the Node side.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export const jobModeSchema = z.enum(['single', 'crawl', 'sitemap', 'batch']);
export type JobMode = z.infer<typeof jobModeSchema>;

export const renderModeSchema = z.enum(['auto', 'http', 'js']);
export type RenderMode = z.infer<typeof renderModeSchema>;

export const extractStrategySchema = z.enum(['auto', 'selectors', 'llm', 'recipe']);
export type ExtractStrategy = z.infer<typeof extractStrategySchema>;

export const fieldTypeSchema = z.enum([
  'text',
  'html',
  'number',
  'integer',
  'bool',
  'date',
  'url',
  'image',
  'list',
  'json',
]);
export type FieldType = z.infer<typeof fieldTypeSchema>;

export const deviceProfileSchema = z.enum(['desktop', 'mobile', 'tablet']);
export type DeviceProfile = z.infer<typeof deviceProfileSchema>;

export const RESERVED_FIELD_NAMES = [
  '__proto__',
  'constructor',
  'prototype',
  'tostring',
  'valueof',
] as const;

/** Same regex as the Python side; the two must not drift. */
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Headers a client may never set. `host` and `content-length` would let a
 * caller redirect the request or desync the transport; the rest are hop-by-hop
 * headers that must be controlled by the HTTP client itself.
 */
export const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
]);

// Matches the engine's hard ceilings. Changing these means changing both sides.
export const HARD_LIMITS = {
  maxPagesPerJob: 5000,
  maxCrawlDepth: 6,
  maxTargets: 500,
  maxFields: 200,
  maxHeaderCount: 30,
  maxBytesPerPage: 25_000_000,
  maxRequestTimeoutMs: 180_000,
} as const;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------
export const extractFieldSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .transform((value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_'))
      .refine((value) => FIELD_NAME_RE.test(value), {
        message: 'Use a snake_case name starting with a letter (a–z, 0–9, _)',
      })
      .refine((value) => !(RESERVED_FIELD_NAMES as readonly string[]).includes(value), {
        message: 'That name is reserved',
      }),
    selector: z.string().max(1000).nullable().optional(),
    selectorType: z.enum(['css', 'xpath']).default('css'),
    attribute: z
      .string()
      .max(100)
      .nullable()
      .optional()
      .refine((value) => !value || !/^on/i.test(value), { message: 'Event-handler attributes are not extractable' }),
    type: fieldTypeSchema.default('text'),
    transforms: z.array(z.string().max(200)).max(20).default([]),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    constant: z.unknown().optional(),
    all: z.boolean().default(false),
    fallbackSelectors: z.array(z.string().max(1000)).max(10).default([]),
    jsonPath: z.string().max(300).nullable().optional(),
  })
  .refine((field) => field.constant !== undefined || Boolean(field.selector || field.jsonPath || field.fallbackSelectors?.length), {
    message: 'A field needs a selector, a jsonPath or a constant value',
    path: ['selector'],
  });

export type ExtractField = z.infer<typeof extractFieldSchema>;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------
export const extractSpecSchema = z.object({
  strategy: extractStrategySchema.default('auto'),
  listSelector: z.string().max(1000).nullable().default(null),
  fields: z.array(extractFieldSchema).max(HARD_LIMITS.maxFields).default([]),
  schema: z.record(z.string(), z.unknown()).nullable().default(null),
  maxRecords: z.number().int().min(1).max(10_000).default(1000),
  dedupeBy: z.array(z.string().max(64)).max(10).default([]),
  minConfidence: z.number().min(0).max(1).default(0.35),
  instructions: z.string().max(2000).nullable().default(null),
});

export const crawlSpecSchema = z.object({
  maxDepth: z.number().int().min(0).max(HARD_LIMITS.maxCrawlDepth).default(2),
  maxPages: z.number().int().min(1).max(HARD_LIMITS.maxPagesPerJob).default(100),
  sameDomain: z.boolean().default(true),
  include: z.array(z.string().max(300)).max(50).default([]),
  exclude: z.array(z.string().max(300)).max(50).default([]),
  useSitemap: z.boolean().default(true),
  followNofollow: z.boolean().default(false),
  delayMs: z.number().int().min(0).max(60_000).default(0),
  concurrency: z.number().int().min(1).max(16).default(4),
  revisit: z.boolean().default(false),
});

export const headerMapSchema = z
  .record(z.string(), z.string())
  .refine((headers) => Object.keys(headers).length <= HARD_LIMITS.maxHeaderCount, {
    message: `At most ${HARD_LIMITS.maxHeaderCount} custom headers are allowed`,
  })
  .superRefine((headers, ctx) => {
    for (const [rawName, value] of Object.entries(headers)) {
      const name = rawName.trim();
      if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(name)) {
        ctx.addIssue({ code: 'custom', message: `Invalid header name: ${name}`, path: [rawName] });
        continue;
      }
      if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
        ctx.addIssue({ code: 'custom', message: `The ${name} header cannot be overridden`, path: [rawName] });
        continue;
      }
      if (/[\r\n\0]/.test(value)) {
        ctx.addIssue({ code: 'custom', message: `Header ${name} contains illegal control characters`, path: [rawName] });
        continue;
      }
      if (value.length > 2048) {
        ctx.addIssue({ code: 'custom', message: `Header ${name} is too long`, path: [rawName] });
      }
    }
  });

export const fetchSpecSchema = z.object({
  render: renderModeSchema.default('auto'),
  waitFor: z.string().max(200).nullable().default(null),
  timeoutMs: z.number().int().min(1000).max(HARD_LIMITS.maxRequestTimeoutMs).default(30_000),
  respectRobots: z.boolean().default(true),
  maxBytes: z.number().int().min(1024).max(HARD_LIMITS.maxBytesPerPage).default(5_000_000),
  headers: headerMapSchema.prefault({}),
  userAgent: z.string().max(400).nullable().default(null),
  proxy: z.string().max(500).nullable().default(null),
  device: deviceProfileSchema.default('desktop'),
  viewportWidth: z.number().int().min(320).max(3840).default(1440),
  viewportHeight: z.number().int().min(240).max(2160).default(900),
  screenshot: z.boolean().default(false),
  saveHtml: z.boolean().default(true),
  blockAssets: z.boolean().default(true),
  followRedirects: z.boolean().default(true),
  maxRedirects: z.number().int().min(0).max(10).default(5),
  referer: z.string().max(2000).nullable().default(null),
});

export const aiSpecSchema = z.object({
  enrich: z.array(z.enum(['summary', 'entities', 'classify', 'keywords', 'sentiment', 'custom'])).max(10).default([]),
  model: z.string().max(100).nullable().default(null),
  temperature: z.number().min(0).max(1).nullable().default(null),
  labels: z.array(z.string().max(80)).max(50).default([]),
  instructions: z.string().max(2000).nullable().default(null),
  maxTokens: z.number().int().min(64).max(8192).nullable().default(null),
});

export const limitsSpecSchema = z.object({
  maxPages: z.number().int().min(1).max(20_000).default(5000),
  maxBytesPerPage: z.number().int().min(1024).max(HARD_LIMITS.maxBytesPerPage).default(5_000_000),
  maxDurationMs: z.number().int().min(10_000).max(86_400_000).default(3_600_000),
  maxAiTokens: z.number().int().min(0).max(2_000_000).default(120_000),
});

/**
 * A target URL. Rejecting non-HTTP schemes here gives the user immediate
 * feedback; the engine's SSRF guard is still the authority on egress.
 */
export const targetUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((value) => value.trim())
  .refine((value) => /^https?:\/\//i.test(value) || /^[\w-]+(\.[\w-]+)+/.test(value), {
    message: 'Enter a full URL, e.g. https://example.com/products',
  })
  .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'That does not look like a valid URL' });

// ---------------------------------------------------------------------------
// The config
// ---------------------------------------------------------------------------
export const scrapeConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    targets: z.array(targetUrlSchema).min(1).max(HARD_LIMITS.maxTargets),
    mode: jobModeSchema.default('single'),
    crawl: crawlSpecSchema.prefault({}),
    fetch: fetchSpecSchema.prefault({}),
    extract: extractSpecSchema.prefault({}),
    ai: aiSpecSchema.prefault({}),
    limits: limitsSpecSchema.prefault({}),
    meta: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((config, ctx) => {
    if (config.extract.strategy === 'selectors' && config.extract.fields.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['extract', 'fields'],
        message: 'Selector extraction needs at least one field',
      });
    }
    if (
      (config.mode === 'crawl' || config.mode === 'sitemap') &&
      config.extract.strategy === 'selectors' &&
      !config.extract.listSelector
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['extract', 'listSelector'],
        message: 'Crawling with explicit selectors needs a list selector to scope each record',
      });
    }
    if (config.ai.enrich.includes('classify') && config.ai.labels.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ai', 'labels'],
        message: 'Classification needs at least one label',
      });
    }
    if (config.ai.enrich.length > 0 && config.limits.maxAiTokens === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'maxAiTokens'],
        message: 'AI enrichment is enabled but the AI token budget is zero',
      });
    }
  });

export type ScrapeConfig = z.infer<typeof scrapeConfigSchema>;
export type CrawlSpec = z.infer<typeof crawlSpecSchema>;
export type FetchSpec = z.infer<typeof fetchSpecSchema>;
export type ExtractSpec = z.infer<typeof extractSpecSchema>;
export type AiSpec = z.infer<typeof aiSpecSchema>;

/** Parse with defaults applied — use this on every inbound config. */
export function parseScrapeConfig(input: unknown): ScrapeConfig {
  return scrapeConfigSchema.parse(input);
}

/** Non-throwing variant for form validation. */
export function safeParseScrapeConfig(input: unknown) {
  return scrapeConfigSchema.safeParse(input);
}

/**
 * A new config with every default filled in. The wizard starts from this, so
 * the shape the user sees is always the shape the engine receives.
 */
export function defaultScrapeConfig(targets: string[] = []): ScrapeConfig {
  return scrapeConfigSchema.parse({ targets: targets.length > 0 ? targets : ['https://example.com'] });
}

/** Flatten Zod issues into something a form can render next to a field. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    out[path] ??= issue.message;
  }
  return out;
}
