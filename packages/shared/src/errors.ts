/**
 * A single error vocabulary shared by the UI, the API routes and the worker.
 *
 * Rules this enforces:
 *  - **Never leak internals.** A Postgres error string, a stack trace or an
 *    engine hostname must never reach a user or a log line. `toPublic()` is the
 *    only thing allowed over the wire.
 *  - **Retryability is explicit.** The worker needs to know whether to retry or
 *    to dead-letter, and guessing from a message string is how infinite retry
 *    loops happen.
 */

import type { Json } from './types.js';

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_config'
  | 'validation_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'ai_budget_exceeded'
  | 'ai_unavailable'
  | 'engine_unavailable'
  | 'engine_error'
  | 'ssrf_blocked'
  | 'robots_disallowed'
  | 'fetch_failed'
  | 'fetch_timeout'
  | 'response_too_large'
  | 'browser_unavailable'
  | 'queue_unavailable'
  | 'storage_error'
  | 'conflict'
  | 'internal_error';

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'engine_unavailable',
  'engine_error',
  'fetch_failed',
  'fetch_timeout',
  'browser_unavailable',
  'queue_unavailable',
  'ai_unavailable',
  'internal_error',
]);

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_config: 422,
  validation_failed: 422,
  rate_limited: 429,
  quota_exceeded: 402,
  ai_budget_exceeded: 402,
  ai_unavailable: 503,
  engine_unavailable: 503,
  engine_error: 502,
  ssrf_blocked: 400,
  robots_disallowed: 403,
  fetch_failed: 502,
  fetch_timeout: 504,
  response_too_large: 413,
  browser_unavailable: 503,
  queue_unavailable: 503,
  storage_error: 500,
  conflict: 409,
  internal_error: 500,
};

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  /** Operator-facing detail. Logged, never returned to a client. */
  internal?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly internal?: string;
  override readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.retryable = options.retryable ?? RETRYABLE.has(options.code);
    this.details = options.details ?? {};
    this.internal = options.internal;
    this.cause = options.cause;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code] ?? 500;
  }

  /**
   * The only representation allowed to cross a process boundary.
   *
   * `details` is asserted to be JSON: everything we put there is field names and
   * messages, never a live object. The assertion is at the boundary rather than
   * in the constructor so callers keep an ergonomic `Record<string, unknown>`.
   */
  toPublic(): { code: ErrorCode; message: string; retryable: boolean; details: Record<string, Json> } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details as Record<string, Json>,
    };
  }

  toJSON() {
    return { error: this.toPublic() };
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Convenience constructors for the common cases. */
export const errors = {
  unauthorized: (message = 'You need to sign in to do that') => new AppError({ code: 'unauthorized', message }),
  forbidden: (message = 'You do not have access to this resource') => new AppError({ code: 'forbidden', message }),
  notFound: (what = 'Resource') => new AppError({ code: 'not_found', message: `${what} not found` }),
  conflict: (message: string) => new AppError({ code: 'conflict', message }),
  invalidConfig: (message: string, details?: Record<string, unknown>) =>
    new AppError({ code: 'invalid_config', message, details }),
  rateLimited: (message = 'Too many requests. Please slow down.') => new AppError({ code: 'rate_limited', message }),
  quotaExceeded: (message: string) => new AppError({ code: 'quota_exceeded', message }),
  engineUnavailable: (internal?: string) =>
    new AppError({
      code: 'engine_unavailable',
      message: 'The scraping engine is unavailable. Your job has been queued and will retry.',
      internal,
      retryable: true,
    }),
  ssrfBlocked: (message = 'That address cannot be scraped because it points to a private or internal network.') =>
    new AppError({ code: 'ssrf_blocked', message }),
  robotsDisallowed: (url?: string) =>
    new AppError({
      code: 'robots_disallowed',
      message: url
        ? `${url} is disallowed by robots.txt. You can override this per job, but you take on the compliance responsibility.`
        : 'This target is disallowed by robots.txt.',
      details: url ? { url } : {},
    }),
  internal: (internal?: string, message = 'Something went wrong on our side. It has been logged.') =>
    new AppError({ code: 'internal_error', message, internal, retryable: true }),
};

/** Map any thrown value into an AppError, preserving AppErrors. */
export function toAppError(value: unknown, fallbackMessage?: string): AppError {
  if (AppError.isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError({
      code: 'internal_error',
      message: fallbackMessage ?? 'Something went wrong.',
      internal: `${value.name}: ${value.message}`,
      cause: value,
    });
  }
  return new AppError({
    code: 'internal_error',
    message: fallbackMessage ?? 'Something went wrong.',
    internal: typeof value === 'string' ? value : 'unknown throwable',
    cause: value,
  });
}
