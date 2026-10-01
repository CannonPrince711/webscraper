import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { features, publicEnv } from '../env';
import { errors } from '@webscraper/shared';

/**
 * Server-side Supabase client bound to the caller's cookies.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **Never trust a session that has not been re-validated.** `getUser()`
 *    asks the auth server; reading the JWT payload locally is a footgun,
 *    because a revoked or expired token still decodes.
 * 2. **RLS is the authorisation layer.** This client carries the user's
 *    identity, so a bug in our query layer cannot read another tenant's rows.
 *    The service-role client in `admin.ts` is the deliberate exception, and is
 *    used only for engine callbacks.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  if (!features.supabase) return null;

  const cookieStore = await cookies();

  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  });
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
}

/** Resolve the caller, or null. Always hits the auth server. */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const user = data.user;
  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    email: user.email ?? null,
    fullName: (metadata.full_name as string | undefined) ?? (metadata.name as string | undefined) ?? null,
    avatarUrl: (metadata.avatar_url as string | undefined) ?? null,
  };
}

/** Require a signed-in user, or throw a typed 401. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (!user) throw errors.unauthorized();
  return user;
}
