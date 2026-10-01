import 'server-only';
import { z } from 'zod';

/**
 * Server-side environment, validated once at module load.
 *
 * Design decisions:
 *
 * - **Everything is optional.** An empty `.env` boots a fully working demo
 *   instance (local JSON store, inline job execution, no LLM). That is what
 *   makes the repo runnable in 30 seconds instead of after a Supabase signup.
 * - **Production refuses to run in demo mode.** Silently serving a demo
 *   instance with real auth would be a catastrophic misconfiguration, so it is
 *   a hard startup failure rather than a warning.
 * - **Secrets are never `NEXT_PUBLIC_`.** The service-role key and the engine
 *   key are read here, in a `server-only` module, so a stray client import
 *   fails the build instead of shipping the key to a browser.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET_ARTIFACTS: z.string().default('artifacts'),
  SUPABASE_STORAGE_BUCKET_EXPORTS: z.string().default('exports'),

  ENGINE_URL: z.string().url().default('http://localhost:8000'),
  ENGINE_API_KEY: z.string().default('dev-engine-key-change-me'),

  REDIS_URL: z.string().optional(),
  QUEUE_PREFIX: z.string().default('webscraper'),

  AI_BASE_URL: z.string().url().optional().or(z.literal('')),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-4o-mini'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Shared secret that authorises the scheduler tick (`/api/cron`). */
  CRON_SECRET: z.string().min(16).optional(),

  MAX_PAGES_PER_JOB: z.coerce.number().int().min(1).max(20_000).default(5000),
  MAX_REQUESTS_PER_MINUTE_PER_ORG: z.coerce.number().int().min(1).default(600),
});

function parseEnv() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Print only the field paths — never the values, which may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}

export const env = parseEnv();

const supabaseConfigured = Boolean(
  env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

/**
 * Capability flags. The UI reads these to hide features rather than showing
 * buttons that can only fail — e.g. no AI provider means no "infer with AI"
 * affordance, not a 503 on click.
 */
export const features = {
  supabase: supabaseConfigured,
  serviceRole: supabaseConfigured && Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
  redis: Boolean(env.REDIS_URL),
  ai: Boolean(env.AI_BASE_URL && env.AI_API_KEY),
  /** True when the app is running on the local JSON store. */
  demoMode: !supabaseConfigured,
} as const;

/**
 * `next build` runs with NODE_ENV=production even on a machine that has no
 * Supabase credentials, and a *build* cannot leak data — only a running server
 * can. Without this exemption, the demo configuration would be unbuildable,
 * which is exactly the configuration the repo ships for evaluation.
 */
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';

/** Fail fast: a production deployment must never serve the demo store. */
if (env.NODE_ENV === 'production' && features.demoMode && !isBuildPhase) {
  throw new Error(
    'Refusing to start: NODE_ENV=production but Supabase is not configured. ' +
      'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, or run with NODE_ENV=development for the demo instance.',
  );
}

if (env.NODE_ENV === 'production' && env.APP_SECRET.startsWith('dev-only') && !isBuildPhase) {
  throw new Error('Refusing to start: APP_SECRET is still the development default. Generate one with `openssl rand -base64 32`.');
}

/** Non-fatal configuration warnings, surfaced in the UI banner and logs. */
export function configurationWarnings(): string[] {
  const warnings: string[] = [];
  if (features.demoMode) {
    warnings.push('Running in demo mode: data is stored in a local JSON file and is not multi-tenant.');
  }
  if (!features.redis) {
    warnings.push('REDIS_URL is not set: jobs run inline in the web process and do not survive a restart.');
  }
  if (!features.ai) {
    warnings.push('No AI provider configured: AI features are hidden. Everything else works.');
  }
  if (features.supabase && !features.serviceRole) {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY is not set: engine callbacks and webhook fan-out are unavailable.');
  }
  return warnings;
}

export const publicEnv = {
  supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
} as const;
