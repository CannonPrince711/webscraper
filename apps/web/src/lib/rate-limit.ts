import 'server-only';
import { AppError } from '@webscraper/shared';
import { env, features } from './env';
import { logger } from './logger';

/**
 * Per-organisation request limiting.
 *
 * Two reasons this exists beyond "don't get hacked":
 *
 *  - **Fairness.** The engine's egress pool is shared. One tenant launching
 *    ten 5,000-page crawls would degrade everyone else's latency.
 *  - **Cost.** Every scrape is a real fetch and, for AI jobs, real money. A
 *    limit converts a runaway loop into a 429 instead of an invoice.
 *
 * In-process by default (correct for a single replica), Redis when configured
 * (correct for several). The Redis path uses an atomic Lua script so two
 * replicas cannot both read "59 requests" and both allow the 60th.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = env.MAX_REQUESTS_PER_MINUTE_PER_ORG;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Sweep expired buckets so a long-running process does not accumulate keys.
function sweep(now: number): void {
  if (buckets.size < 5_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

function inProcessLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }

  bucket.count += 1;
  const allowed = bucket.count <= max;
  return { allowed, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
}

const LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { current, redis.call('PTTL', KEYS[1]) }
`;

type RedisLike = {
  eval: (script: string, numberOfKeys: number, ...args: (string | number)[]) => Promise<unknown>;
};

let redisClient: RedisLike | null = null;
let redisFailed = false;

async function getRedis(): Promise<RedisLike | null> {
  if (!features.redis || redisFailed) return null;
  if (redisClient) return redisClient;

  try {
    const { default: IORedis } = await import('ioredis');
    const client = new IORedis(env.REDIS_URL as string, { maxRetriesPerRequest: 2, enableReadyCheck: false });
    client.on('error', (error: Error) => logger.warn('Rate-limit Redis error', { reason: error.name }));
    redisClient = client as unknown as RedisLike;
    return redisClient;
  } catch (error) {
    redisFailed = true;
    logger.exception('Falling back to in-process rate limiting', error);
    return null;
  }
}

export async function checkRateLimit(
  key: string,
  options: { max?: number; windowMs?: number } = {},
): Promise<RateLimitResult> {
  const max = options.max ?? DEFAULT_MAX;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windowKey = `ratelimit:${key}:${Math.floor(Date.now() / windowMs)}`;

  const redis = await getRedis();
  if (redis) {
    try {
      const result = (await redis.eval(LUA, 1, windowKey, windowMs * 2)) as [number, number];
      const count = Number(result?.[0] ?? 1);
      const ttl = Number(result?.[1] ?? windowMs);
      return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        resetAt: Date.now() + Math.max(ttl, 0),
      };
    } catch (error) {
      logger.warn('Rate-limit Redis call failed; using the in-process limiter', { reason: (error as Error).name });
    }
  }

  return inProcessLimit(windowKey, max, windowMs);
}

/** Enforce the limit, throwing a typed 429 with a retry hint. */
export async function enforceRateLimit(
  key: string,
  options: { max?: number; windowMs?: number } = {},
): Promise<void> {
  const result = await checkRateLimit(key, options);
  if (result.allowed) return;

  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  throw new AppError({
    code: 'rate_limited',
    message: `Too many requests. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    details: { retryAfterSeconds },
  });
}
