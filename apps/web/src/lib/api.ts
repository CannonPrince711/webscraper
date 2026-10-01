import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError, toAppError, type ApiErrorBody } from '@webscraper/shared';
import { logger } from './logger';

/**
 * The single exit point for every API route.
 *
 * Guarantees, in order of importance:
 *  1. **No internal detail escapes.** A Postgres error code, a stack trace or an
 *     engine hostname never appears in a response body.
 *  2. **Errors have a stable shape.** `{ error: { code, message, retryable } }`
 *     so the client can switch on `code` instead of matching prose.
 *  3. **Retryable failures advertise it**, along with `Retry-After`, so a client
 *     or the worker knows whether to back off.
 */

export interface RouteContext {
  requestId: string;
}

function requestId(request: Request): string {
  return request.headers.get('x-request-id') ?? Math.random().toString(36).slice(2, 12);
}

export function jsonOk<T>(data: T, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: {
      'cache-control': 'no-store, max-age=0',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function jsonError(error: unknown, context: RouteContext): NextResponse {
  const appError = toAppError(error);
  const body: ApiErrorBody = appError.toPublic();

  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (appError.retryable) headers['retry-after'] = '5';

  // Log the operator-facing detail here, where it stays; the client gets the
  // sanitised body only.
  const logContext = {
    requestId: context.requestId,
    code: appError.code,
    status: appError.httpStatus,
    internal: appError.internal,
  };
  if (appError.httpStatus >= 500) logger.error('API error', logContext);
  else logger.warn('API error', logContext);

  return NextResponse.json({ error: body }, { status: appError.httpStatus, headers });
}

/**
 * Wrap a route handler so every throw becomes a typed, sanitised response.
 *
 * Returns `Response`, not `NextResponse`, so streaming endpoints (see
 * `api/runs/[id]/stream`) can use the same wrapper and inherit the same error
 * translation instead of hand-rolling their own.
 */
export function route<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
): (request: Request, ...args: Args) => Promise<Response> {
  return async (request: Request, ...args: Args) => {
    const context: RouteContext = { requestId: requestId(request) };
    try {
      return await handler(request, ...args);
    } catch (error) {
      return jsonError(error, context);
    }
  };
}

/** Parse a JSON body with a size guard, converting failures into typed errors. */
export async function readJson<T = unknown>(request: Request, maxBytes = 2_000_000): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) {
    throw new AppError({ code: 'validation_failed', message: 'That request body is too large.' });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new AppError({ code: 'validation_failed', message: 'Could not read the request body.' });
  }

  if (text.length > maxBytes) {
    throw new AppError({ code: 'validation_failed', message: 'That request body is too large.' });
  }
  if (!text.trim()) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError({ code: 'validation_failed', message: 'The request body was not valid JSON.' });
  }
}

/**
 * Convert a Zod failure into a field-level error the UI can render inline.
 * Only paths and messages are returned — never the offending value, which may
 * be personal data from a scrape.
 */
export function fromZod(error: ZodError): AppError {
  const problems = error.issues.slice(0, 12).map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return new AppError({
    code: 'invalid_config',
    message: problems[0]?.message ?? 'The request did not validate.',
    details: { problems },
  });
}

/** Parse and validate a query parameter, with a safe fallback. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function boolParam(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
