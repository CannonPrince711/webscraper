/**
 * Constants shared by the UI and the worker: status presentation, queue names
 * and the webhook event vocabulary.
 *
 * Keeping these in one place is what stops the worker emitting `run.completed`
 * while the UI listens for `run.succeeded`.
 */

export const QUEUE_NAMES = {
  scrape: 'scrape',
  crawl: 'crawl',
  ai: 'ai',
  deliver: 'deliver',
  schedule: 'schedule',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_PREFIX = 'webscraper';

export const WEBHOOK_EVENTS = [
  'run.started',
  'run.succeeded',
  'run.failed',
  'run.partial',
  'job.created',
  'job.updated',
  'monitor.triggered',
  'quota.warning',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_KEY_SCOPES = [
  'jobs:read',
  'jobs:write',
  'jobs:run',
  'records:read',
  'records:export',
  'webhooks:manage',
  'admin',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface StatusPresentation {
  label: string;
  /** Tailwind classes for a pill. Dark-mode first, light fallback included. */
  className: string;
  dotClassName: string;
}

const STATUS_MAP: Record<string, StatusPresentation> = {
  draft: {
    label: 'Draft',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
    dotClassName: 'bg-slate-400',
  },
  queued: {
    label: 'Queued',
    className: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
    dotClassName: 'bg-sky-500',
  },
  running: {
    label: 'Running',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
    dotClassName: 'bg-blue-500 animate-pulse',
  },
  succeeded: {
    label: 'Succeeded',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
    dotClassName: 'bg-emerald-500',
  },
  partial: {
    label: 'Partial',
    className: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
    dotClassName: 'bg-amber-500',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300',
    dotClassName: 'bg-rose-500',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400',
    dotClassName: 'bg-zinc-400',
  },
  paused: {
    label: 'Paused',
    className: 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
    dotClassName: 'bg-violet-500',
  },
  timeout: {
    label: 'Timed out',
    className: 'bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-300',
    dotClassName: 'bg-orange-500',
  },
  blocked_robots: {
    label: 'Robots',
    className: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-950/60 dark:text-yellow-300',
    dotClassName: 'bg-yellow-500',
  },
  blocked_ssrf: {
    label: 'Blocked',
    className: 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-300',
    dotClassName: 'bg-red-600',
  },
  http_error: {
    label: 'HTTP error',
    className: 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300',
    dotClassName: 'bg-rose-500',
  },
  too_large: {
    label: 'Too large',
    className: 'bg-orange-100 text-orange-900 dark:bg-orange-950/60 dark:text-orange-300',
    dotClassName: 'bg-orange-500',
  },
  not_modified: {
    label: 'Unchanged',
    className: 'bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300',
    dotClassName: 'bg-teal-500',
  },
  ok: {
    label: 'OK',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
    dotClassName: 'bg-emerald-500',
  },
};

const UNKNOWN_STATUS: StatusPresentation = {
  label: 'Unknown',
  className: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-400',
  dotClassName: 'bg-slate-400',
};

export function statusPresentation(status: string | null | undefined): StatusPresentation {
  if (!status) return UNKNOWN_STATUS;
  return STATUS_MAP[status] ?? { ...UNKNOWN_STATUS, label: status.replace(/_/g, ' ') };
}

/** Reason codes the engine can return, mapped to advice a user can act on. */
export const FAILURE_GUIDANCE: Record<string, string> = {
  ssrf_blocked: 'This URL resolves to a private or internal address. Pick a public target.',
  robots_disallowed: 'robots.txt disallows this path. You can override it per job if you have the right to scrape it.',
  robots_disallowed_redirect: 'The page redirected to a path that robots.txt disallows.',
  fetch_timeout: 'The target was too slow. Increase the timeout, or switch rendering to HTTP only.',
  response_too_large: 'The page exceeded the size limit. Raise "max bytes" if you really need all of it.',
  unsupported_content_type: 'The URL returned something that is not a web page (an image, PDF or archive).',
  http_404: 'The page does not exist. Check the URL, or start from a listing page instead.',
  http_403: 'The site refused the request. It may require a proxy, a different user agent, or an account.',
  http_429: 'The site rate-limited us. Lower the requests per second for this domain.',
  browser_unavailable: 'JavaScript rendering is disabled on this engine. Enable it, or choose HTTP-only rendering.',
  dns_failure: 'The hostname did not resolve. Check for a typo.',
  deadline_exceeded: 'The job hit its time limit. Reduce the page count or raise the limit.',
  no_records_extracted: 'The page loaded but no data matched. Try auto-detection, or pick elements manually.',
};

export function guidanceFor(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null;
  return FAILURE_GUIDANCE[errorCode] ?? null;
}

export const CRAWL_PRESETS = [
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 6 * * *', label: 'Daily at 06:00' },
  { value: '0 9 * * 1', label: 'Weekly (Mon 09:00)' },
  { value: '0 9 1 * *', label: 'Monthly (1st, 09:00)' },
] as const;

export const RENDER_MODE_HELP: Record<string, string> = {
  auto: 'Tries a fast HTTP fetch first and only launches a browser if the page looks like an empty JavaScript shell. Right answer for most sites.',
  http: 'Never launches a browser. Fastest and cheapest, but returns nothing for client-rendered pages.',
  js: 'Always renders in a headless browser. Use for sites you know are JavaScript-heavy; costs ~50× more CPU per page.',
};

export const EXTRACT_STRATEGY_HELP: Record<string, string> = {
  auto: 'Reads structured data (JSON-LD, Open Graph) first, then detects repeating records structurally. Free, deterministic and the best default.',
  selectors: 'Exact CSS/XPath selectors you pick. Fully reproducible; breaks if the site is redesigned.',
  llm: 'Asks a language model to extract the data. Handles ambiguous layouts, costs tokens per page, and is non-deterministic.',
  recipe: 'A saved selector configuration, replayed exactly.',
};

export const DEMO_USER = {
  id: 'demo-user-0000-0000-0000-000000000001',
  email: 'demo@webscraper.local',
  fullName: 'Demo User',
} as const;

export const DEMO_ORG = {
  id: 'demo-org-0000-0000-0000-000000000001',
  name: 'Demo Workspace',
  slug: 'demo-workspace',
} as const;
