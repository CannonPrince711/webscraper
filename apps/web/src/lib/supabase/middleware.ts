import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session refresh + route protection.
 *
 * Supabase access tokens are short-lived; without a refresh on every request a
 * user is silently logged out mid-session. The refreshed cookies must be
 * written both onto the outgoing response *and* onto the request object passed
 * to `NextResponse.next`, otherwise the App Router renders with the stale token.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Demo mode: no auth, everything is reachable.
  if (!url || !anonKey) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not insert logic between createServerClient and getUser(): the refresh
  // happens inside this call, and anything that throws skips it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isApi = path.startsWith('/api/');

  const isPublic =
    path === '/' ||
    path.startsWith('/login') ||
    path.startsWith('/auth') ||
    // The scheduler authenticates itself with CRON_SECRET; it has no session.
    path.startsWith('/api/cron') ||
    path.startsWith('/api/health') ||
    path.startsWith('/_next') ||
    path.startsWith('/favicon');

  if (!user && !isPublic) {
    // An API caller wants a status code, not an HTML login page. Redirecting
    // `fetch()` to /login produces a confusing "Unexpected token '<'" in the
    // client instead of a 401 the code can handle.
    if (isApi) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: 'Sign in to continue.', retryable: false, details: {} } },
        { status: 401, headers: { 'cache-control': 'no-store' } },
      );
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', path);
    return NextResponse.redirect(loginUrl);
  }

  if (user && path === '/login') {
    const dashboard = request.nextUrl.clone();
    dashboard.pathname = '/dashboard';
    dashboard.search = '';
    return NextResponse.redirect(dashboard);
  }

  return response;
}
