import { env } from './env.js';

/**
 * Structured logs, one JSON object per line.
 *
 * A worker has no request to attach context to, so the context has to be in
 * every line: `jobId`, `runId`, `orgId`. In production those come from the
 * queue payload and are threaded through explicitly rather than stored in a
 * module-level "current run" variable — that pattern is how two concurrent runs
 * end up sharing one runId in the logs, which is worse than no logs.
 *
 * Secrets are redacted by key name, so passing a whole env object to the logger
 * cannot leak a key.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const REDACT = /(secret|token|key|password|authorization|cookie|signature)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((entry) => redact(entry, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    if (entry instanceof Error) {
      output[key] = { name: entry.name, message: entry.message };
      continue;
    }
    output[key] = redact(entry, depth + 1);
  }
  return output;
}

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: 'worker',
    message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  });

  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
  exception: (message: string, error: unknown, context?: Record<string, unknown>) => {
    emit('error', message, {
      ...context,
      error: error instanceof Error ? { name: error.name, message: error.message } : { value: String(error) },
    });
  },
};
