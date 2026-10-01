import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * Load the monorepo-root `.env` when running from a checkout.
 *
 * In production the worker gets its environment from the orchestrator, and no
 * file is present — hence the silent, existence-checked load. Existing
 * variables are never overwritten.
 */
for (const candidate of ['.env', '../.env', '../../.env']) {
  const path = resolve(process.cwd(), candidate);
  if (existsSync(path)) {
    try {
      (process as unknown as { loadEnvFile?: (file: string) => void }).loadEnvFile?.(path);
    } catch {
      // Reported by the schema below, with the variable name that is wrong.
    }
    break;
  }
}

/**
 * Worker configuration, validated once at boot.
 *
 * The worker is the opposite of the web app: it has **no demo mode**, because
 * its entire job is durable background work against a real database. Missing
 * credentials are therefore a fatal, immediate error with a message that says
 * what to do — not a silent fallback that processes nothing.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Required: the worker operates on behalf of every tenant, so it holds the
  // service-role key. It is never given to a browser and never logged.
  SUPABASE_URL: z.string().url({ message: 'SUPABASE_URL must be the project URL, e.g. https://xyz.supabase.co' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET_ARTIFACTS: z.string().default('artifacts'),

  ENGINE_URL: z.string().url().default('http://localhost:8000'),
  ENGINE_API_KEY: z.string().default('dev-engine-key-change-me'),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(240_000),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  QUEUE_PREFIX: z.string().default('webscraper'),

  /** How many runs may execute at once in this process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /** How many webhook deliveries may be in flight at once. */
  DELIVER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /** Stop a single run after this long, whatever the job config says. */
  RUN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(24 * 3_600_000).default(3_600_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  /** Upload HTML/screenshots to Supabase Storage instead of keeping them inline. */
  UPLOAD_ARTIFACTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** Small HTTP server exposing /healthz and /metrics for the orchestrator. */
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(9090),
  APP_URL: z.string().url().default('http://localhost:3000'),
});

function parse() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(
      `Invalid worker configuration:\n${problems.join('\n')}\n\n` +
        'The worker needs Supabase credentials because it writes on behalf of every tenant. ' +
        'For a credential-free demo, leave REDIS_URL unset in the web app and runs execute inline.',
    );
  }
  return parsed.data;
}

export const env = parse();

export const features = {
  uploadArtifacts: env.UPLOAD_ARTIFACTS,
  /** The web app is configured to hand work to this worker. */
  appConfigured: Boolean(env.APP_URL),
} as const;
