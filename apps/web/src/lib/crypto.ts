import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env';

/**
 * Cryptographic primitives for API keys, webhook signatures and internal
 * callbacks. Everything is server-only; nothing here may be imported into a
 * client component.
 */

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
const API_KEY_PREFIX = 'ws_live';

/**
 * Generate an API key. The plaintext is returned **exactly once** and only the
 * SHA-256 hash is persisted, so a database leak does not yield usable keys.
 * The display prefix lets a user identify a key in a list without revealing it.
 */
export function generateApiKey(): { secret: string; hash: string; prefix: string } {
  const entropy = randomBytes(32).toString('base64url');
  const secret = `${API_KEY_PREFIX}_${entropy}`;
  return {
    secret,
    hash: hashApiKey(secret),
    // Enough to be recognisable, far too little to brute-force.
    prefix: `${API_KEY_PREFIX}_${entropy.slice(0, 6)}…`,
  };
}

/**
 * Hash an API key. The app secret acts as a pepper, so hashes are useless
 * without it even if the database is dumped.
 */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(`${env.APP_SECRET}:${secret}`).digest('hex');
}

export function verifyApiKey(secret: string, hash: string): boolean {
  return safeEqual(hashApiKey(secret), hash);
}

/** Constant-time comparison for equal-length hex strings. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Webhook and internal-callback signatures
// ---------------------------------------------------------------------------
/**
 * `X-Webscraper-Signature: t=<unix>,v1=<hex>` — HMAC-SHA256 over
 * `"{t}.{body}"`. The timestamp is inside the signed payload, so a captured
 * request cannot be replayed and a mutated body is rejected.
 */
export function signPayload(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyPayloadSignature(
  header: string | null,
  body: string,
  secret: string,
  maxSkewSeconds = 300,
): boolean {
  if (!header) return false;
  const parts = new Map(
    header
      .split(',')
      .map((chunk) => chunk.trim().split('=', 2))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');
  if (!provided || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > maxSkewSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return safeEqual(expected, provided);
}

/** Signature for engine → web callbacks, keyed on APP_SECRET. */
export function signEngineCallback(body: string): string {
  return signPayload(body, env.APP_SECRET);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe random token for invitations and one-time links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
