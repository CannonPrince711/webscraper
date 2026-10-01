/**
 * Variables editable from Settings in the desktop app.
 *
 * This is a whitelist, not a passthrough: the Settings page can only touch the
 * keys listed here, so it can never overwrite `APP_SECRET`, `ENGINE_API_KEY` or
 * anything that would let a request redirect where secrets are sent. Values are
 * stored in the portable data folder's `.env`, which the launcher loads at
 * start-up (hence "restart to apply").
 *
 * Pure functions only (no `server-only`, no I/O) so they are unit-testable.
 */

export type VarKind = 'string' | 'url' | 'bool' | 'int';

export interface SettingVar {
  key: string;
  label: string;
  group: 'AI provider' | 'Proxy' | 'Scraping engine' | 'Limits' | 'Updates';
  kind: VarKind;
  /** Secrets are never sent back to the browser; only "is set" is. */
  secret?: boolean;
  hint?: string;
  /** What applies when unset (shown by toggles). */
  defaultValue?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

export const SETTING_VARS: readonly SettingVar[] = [
  { key: 'AI_BASE_URL', label: 'Base URL', group: 'AI provider', kind: 'url', placeholder: 'https://api.openai.com/v1', hint: 'Any OpenAI-compatible endpoint, including a local Ollama.' },
  { key: 'AI_API_KEY', label: 'API key', group: 'AI provider', kind: 'string', secret: true },
  { key: 'AI_MODEL', label: 'Model', group: 'AI provider', kind: 'string', placeholder: 'gpt-4o-mini' },

  { key: 'DECODO_USERNAME', label: 'Decodo username', group: 'Proxy', kind: 'string', placeholder: 'user-yourname' },
  { key: 'DECODO_PASSWORD', label: 'Decodo password', group: 'Proxy', kind: 'string', secret: true },
  { key: 'DECODO_ENDPOINT', label: 'Decodo endpoint', group: 'Proxy', kind: 'string', placeholder: 'gate.decodo.com:7000' },
  { key: 'DECODO_COUNTRY', label: 'Default country', group: 'Proxy', kind: 'string', placeholder: 'us', hint: 'ISO-3166 alpha-2. Blank uses the account default.' },
  { key: 'DECODO_SESSION_MINUTES', label: 'Sticky session minutes', group: 'Proxy', kind: 'int', min: 1, max: 1440 },
  { key: 'ENGINE_PROXY_URLS', label: 'Custom proxy URLs', group: 'Proxy', kind: 'string', secret: true, hint: 'Comma separated. May embed credentials, so it is treated as a secret.' },

  { key: 'ENGINE_ENABLE_BROWSER', label: 'Headless browser rendering', group: 'Scraping engine', kind: 'bool', defaultValue: 'false', hint: 'Needs Playwright Chromium, which the desktop build does not bundle.' },
  { key: 'ENGINE_RESPECT_ROBOTS', label: 'Respect robots.txt', group: 'Scraping engine', kind: 'bool' },
  { key: 'ENGINE_MAX_CONCURRENCY', label: 'Max concurrency', group: 'Scraping engine', kind: 'int', min: 1, max: 64 },
  { key: 'ENGINE_REQUEST_TIMEOUT_MS', label: 'Request timeout (ms)', group: 'Scraping engine', kind: 'int', min: 1000, max: 300000 },

  { key: 'MAX_PAGES_PER_JOB', label: 'Max pages per job', group: 'Limits', kind: 'int', min: 1, max: 20000 },

  { key: 'WEBSCRAPER_AUTO_UPDATE', label: 'Install updates automatically at start-up', group: 'Updates', kind: 'bool', defaultValue: 'true', hint: 'Checks GitHub Releases when the app starts.' },
];

const BY_KEY = new Map(SETTING_VARS.map((item) => [item.key, item]));

export function findVar(key: string): SettingVar | undefined {
  return BY_KEY.get(key);
}

/** Validate one value. Returns an error message, or `null` when acceptable. */
export function validateValue(item: SettingVar, value: string): string | null {
  if (value === '') return null; // clearing is always allowed
  if (/[\r\n\0]/.test(value)) return `${item.label} cannot contain line breaks.`;
  if (value.length > 2048) return `${item.label} is too long.`;
  switch (item.kind) {
    case 'bool':
      return value === 'true' || value === 'false' ? null : `${item.label} must be true or false.`;
    case 'int': {
      if (!/^\d+$/.test(value)) return `${item.label} must be a whole number.`;
      const n = Number(value);
      if (item.min !== undefined && n < item.min) return `${item.label} must be at least ${item.min}.`;
      if (item.max !== undefined && n > item.max) return `${item.label} must be at most ${item.max}.`;
      return null;
    }
    case 'url':
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? null : `${item.label} must be an http(s) URL.`;
      } catch {
        return `${item.label} must be a valid URL.`;
      }
    default:
      return null;
  }
}

/** Parse KEY=VALUE text the same way the launcher does (quotes stripped). */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function formatValue(value: string): string {
  // The launcher strips one pair of surrounding quotes and does not unescape,
  // so quote only when whitespace or a comment marker would otherwise be lost,
  // and refuse values that contain the quote character itself.
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

/**
 * Apply updates to existing `.env` text, preserving comments, ordering and keys
 * this page does not manage. `null` removes a key.
 */
export function applyEnvUpdates(text: string, updates: Record<string, string | null>): string {
  const pending = new Map(Object.entries(updates));
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const out: string[] = [];

  for (const raw of lines) {
    const eq = raw.indexOf('=');
    const key = eq > 0 && !raw.trim().startsWith('#') ? raw.slice(0, eq).trim() : null;
    if (key && pending.has(key)) {
      const next = pending.get(key);
      pending.delete(key);
      if (next !== null && next !== undefined) out.push(`${key}=${formatValue(next)}`);
      continue;
    }
    out.push(raw);
  }
  while (out.length > 0 && out.at(-1) === '') out.pop();
  for (const [key, value] of pending) {
    if (value !== null) out.push(`${key}=${formatValue(value)}`);
  }
  return out.join('\n') + '\n';
}
