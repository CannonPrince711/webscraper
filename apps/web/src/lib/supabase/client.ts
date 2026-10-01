'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client.
 *
 * Only the **anon** key is used here, so every query is subject to Row Level
 * Security. The service-role key must never reach this file — it lives in
 * `admin.ts`, which is `server-only`.
 */
let cached: SupabaseClient | null = null;

export function createSupabaseBrowserClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;   // demo mode: no client, no crash

  cached ??= createBrowserClient(url, anonKey);
  return cached;
}
