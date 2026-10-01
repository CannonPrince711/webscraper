import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * Request middleware.
 *
 * Its single job is refreshing the Supabase session and enforcing that
 * authenticated pages are only served to authenticated people (see
 * `lib/supabase/middleware.ts`). Business logic does **not** belong here: this
 * runs on every request including static-ish routes, and a middleware that
 * queries the database is a middleware that adds latency to everything.
 *
 * The matcher below skips Next internals and static files. That is not just an
 * optimisation — running session refresh for every icon request burns a token
 * refresh per asset on a cold page load.
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match everything except:
     *  - _next/static, _next/image  (build output)
     *  - common static file extensions
     *  - the favicon and robots/sitemap files
     */
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|mjs|map|txt|woff|woff2|ttf|otf)$).*)',
  ],
};
