import 'server-only';
import { env } from './env';

/**
 * Structured logging with mandatory redaction.
 *
 * A scraper handles two categories of sensitive data by accident: credentials
 * (engine keys, service-role keys, proxy passwords) and third-party personal
 * data (scraped content). Neither may reach a log drain. `redact` runs on every
 * value before it is serialised, so a careless `log.info({ url, headers })`
 * cannot leak a bearer token.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  /\b(api[-_]?key|token|secret|password|authorization|apikey)\b\s*[:=]\s*\S+/gi,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:set-)?cookie\b\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sbp|sb)_[A-Za-z0-9_-]{20,}\b/g, // Supabase key prefixes
];

const SENSITIVE_KEYS = new Set([
  'password', 'token', 'secret', 'authorization', 'cookie', 'apikey', 'api_key',
  'service_role_key', 'engine_api_key', 'access_token', 'refresh_token',
  'proxy', 'proxy_url', 'private_key', 'credentials', 'client_secret',
]);

const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    let output = value;
    for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, REDACTED);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: redact(message),
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
  /** Log a thrown value without ever printing a stack to a shared drain. */
  exception: (message: string, error: unknown, context?: Record<string, unknown>) =>
    emit('error', message, {
      ...context,
      error: error instanceof Error ? { name: error.name, message: error.message } : redact(error),
    }),
};
