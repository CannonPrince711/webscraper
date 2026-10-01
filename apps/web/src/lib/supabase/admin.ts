import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, features } from '../env';

/**
 * Service-role client — **bypasses Row Level Security**.
 *
 * This is the only module in the codebase allowed to construct it, and it has
 * exactly three legitimate uses:
 *
 *   1. Engine → web callbacks (`/api/internal/*`), where there is no user
 *      session but the caller is authenticated by HMAC.
 *   2. Webhook fan-out and scheduled work, which run outside a request.
 *   3. Storage maintenance (retention purges).
 *
 * If you are reaching for this because a query returned nothing, the fix is a
 * policy or a join — not this file. Every historical data-leak incident in a
 * multi-tenant app starts with a line like that one.
 *
 * `import 'server-only'` makes an accidental client import a build error
 * rather than a production incident.
 */
let cached: SupabaseClient | null = null;

export function createSupabaseAdminClient(): SupabaseClient | null {
  if (!features.serviceRole) return null;
  cached ??= createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': 'webscraper-admin' } },
  });
  return cached;
}

/**
 * Guard for internal endpoints. Fails closed: if the service-role key is
 * absent, the caller gets 503 rather than an unauthenticated fallback path.
 */
export function requireAdminClient(): SupabaseClient {
  const client = createSupabaseAdminClient();
  if (!client) {
    throw new Error('Service role is not configured: SUPABASE_SERVICE_ROLE_KEY is missing.');
  }
  return client;
}
