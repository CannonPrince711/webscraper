/**
 * Small, dependency-free helpers shared by the web app, the worker and tests.
 *
 * Everything here must run in **both** Node and the browser, so it uses Web
 * Crypto (`globalThis.crypto.subtle`) rather than `node:crypto`.
 */

/** Conditional className joiner — the `cn` every component imports. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
async function digest(algorithm: 'SHA-256', value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(value: string): Promise<string> {
  return digest('SHA-256', value);
}

/**
 * Canonical JSON: keys sorted recursively so two structurally identical records
 * always hash the same. This is what makes change detection trustworthy.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function contentHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** Constant-time string comparison — used for HMAC and API key checks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// URL handling (mirrors services/engine/app/core/urlnorm.py)
// ---------------------------------------------------------------------------
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'yclid',
  'twclid', 'igshid', '_ga', '_gl', 'ref', 'ref_src', 'spm', 'scm', 'trk',
  'sessionid', 'phpsessid', 'sid',
]);

/**
 * Canonical URL form for de-duplication. Kept identical to the Python
 * implementation: if the two disagree, the crawler revisits pages it has
 * already seen and the frontier never converges.
 */
export function normalizeUrl(
  input: string,
  options: { stripTracking?: boolean; stripFragment?: boolean } = {},
): string {
  const { stripTracking = true, stripFragment = true } = options;
  const raw = input.trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.(html?|php)$/i, '') || '/';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    if (stripTracking) {
      const kept: Array<[string, string]> = [];
      for (const [key, value] of url.searchParams.entries()) {
        if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value]);
      }
      kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      url.search = '';
      for (const [key, value] of kept) url.searchParams.append(key, value);
    }
    if (stripFragment) url.hash = '';
    return url.toString().replace(/\/(\?|$)/, '$1');
  } catch {
    return raw;
  }
}

/** The registrable-ish domain, used for display and per-site grouping. */
export function domainOf(input: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return input;
  }
}

export function isSameSite(a: string, b: string): boolean {
  return domainOf(a) === domainOf(b);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function formatNumber(value: number | null | undefined, options: Intl.NumberFormatOptions = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: value >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1, ...options }).format(value);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatRelativeTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const seconds = Math.abs(diffMs) / 1000;

  const table: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86_400, 'hour'],
    [604_800, 'day'],
    [2_592_000, 'week'],
    [31_536_000, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  const divisor = seconds < 60 ? 1 : seconds < 3600 ? 60 : seconds < 86_400 ? 3600 : seconds < 604_800 ? 86_400 : seconds < 2_592_000 ? 604_800 : seconds < 31_536_000 ? 2_592_000 : 31_536_000;
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  void table;
  return format.format(Math.round((future ? 1 : -1) * (seconds / divisor)), divisor === 1 ? 'second' : divisor === 60 ? 'minute' : divisor === 3600 ? 'hour' : divisor === 86_400 ? 'day' : divisor === 604_800 ? 'week' : divisor === 2_592_000 ? 'month' : 'year');
}

export function formatDate(input: string | Date | null | undefined, withTime = true): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function truncate(value: string | null | undefined, limit = 120): string {
  if (!value) return '';
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
/**
 * Neutralise spreadsheet formula injection.
 *
 * A cell beginning with `=`, `+`, `-`, `@`, TAB or CR is executed as a formula
 * by Excel and Sheets. The content came from an untrusted web page, so it is
 * prefixed with an apostrophe. Quoting alone does **not** fix this.
 */
export function csvSafe(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? canonicalJson(value) : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function escapeCsvValue(value: unknown): string {
  const text = csvSafe(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0 && !columns?.length) return '';
  const headers = columns ?? Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [headers.map(escapeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvValue(row[header])).join(','));
  }
  return lines.join('\r\n');
}

export function toJsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

/** Never index into `Object.prototype` when spreading scraped keys. */
export function safeRecord(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(data)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = value;
  }
  return { ...out };
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter — used by webhook delivery and retries. */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 300_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

// ---------------------------------------------------------------------------
// Scope matching (crawl include/exclude rules)
// ---------------------------------------------------------------------------

/**
 * Turn a user-written glob into a regular expression.
 *
 * The rules are chosen to match what people mean when they type them into a
 * crawl filter, which is not quite what a shell does:
 *
 *   - `*`  matches within one path segment (`/blog/*` → `/blog/post`, not `/blog/a/b`)
 *   - a **trailing** `*` spans slashes, because "exclude `/blog*`" means the
 *     whole blog subtree, not just `/blog-post`
 *   - `**` always spans slashes anywhere
 *   - `?`  matches a single character
 *
 * Everything else is escaped, so a pattern containing `.` or `+` cannot become
 * an accidental regex.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        source += '.*';
        index += 1;
      } else if (index === pattern.length - 1) {
        source += '.*';
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

const globCache = new Map<string, RegExp>();

function cachedGlob(pattern: string): RegExp {
  let compiled = globCache.get(pattern);
  if (!compiled) {
    compiled = globToRegExp(pattern);
    // Bounded cache: patterns come from job configs, which are user input.
    if (globCache.size > 500) globCache.clear();
    globCache.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Does `input` (a URL or a path+search) match any of these globs?
 *
 * Patterns may be written as a bare path (`/blog*`), or as a full URL/host
 * prefix (`example.com/blog*`) — both are common in the wild, and rejecting one
 * of them produces a crawl filter that silently matches nothing.
 */
export function pathMatchesAny(input: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;

  let path = input;
  let hostPath = input;
  try {
    const url = new URL(input);
    path = `${url.pathname}${url.search}`;
    hostPath = `${url.hostname}${url.pathname}${url.search}`;
  } catch {
    // Already a path, or not a URL at all: match it as-is.
  }

  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;

    // A pattern with a scheme or a leading host is matched against host+path.
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[^/]+\.[^/]+/.test(trimmed) ? hostPath : path;
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

    return cachedGlob(withoutScheme).test(candidate);
  });
}

/**
 * Host matching for allow/deny lists.
 *
 *  - `example.com` matches `example.com` and `www.example.com` (people write
 *    both and mean the same site)
 *  - `*.example.com` matches the domain itself and any subdomain (an allow-list
 *    that excludes the bare domain is a footgun, so it does not do that)
 *  - a full URL is accepted and reduced to its host
 */
export function domainMatches(host: string, pattern: string): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/\.$/, '');

  const target = normalise(host);
  const rule = normalise(pattern);
  if (!target || !rule) return false;

  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return target === base || target.endsWith(`.${base}`);
  }

  return target === rule || target === `www.${rule}` || `www.${target}` === rule;
}
