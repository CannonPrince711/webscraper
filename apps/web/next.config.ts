import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * Load the monorepo-root `.env`.
 *
 * Next only reads `.env*` files inside its own project directory (`apps/web`),
 * while every service in this repo shares one `.env` at the root — that is what
 * makes `npm run dev` a single command. Node's built-in loader parses it and,
 * importantly, never overwrites a variable that is already set, so
 * `apps/web/.env.local` and real process environment variables still win.
 */
const rootEnvFile = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnvFile)) {
  try {
    // Guarded because `loadEnvFile` is Node 20.12+; the repo requires >=20.11.
    (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(rootEnvFile);
  } catch {
    // A malformed .env must not stop the server from booting unhelpfully: the
    // schema in src/lib/env.ts names the offending variable with a clear error.
  }
}

/**
 * Next.js configuration.
 *
 * The security headers here are the ones that matter for a multi-tenant app
 * that renders scraped content:
 *
 *  - **CSP without `unsafe-eval`.** A nonce is not used because Next's App
 *    Router inlines its own bootstrap scripts; `'unsafe-inline'` for scripts is
 *    avoided by relying on Next's own nonce injection when a `nonce` is present.
 *    For a product that displays third-party HTML, the CSP is the backstop.
 *  - **`frame-ancestors 'none'`** stops clickjacking of the dashboard.
 *  - **`X-Content-Type-Options: nosniff`** stops a scraped HTML page being
 *    interpreted as something executable.
 *  - **`serverExternalPackages`** keeps BullMQ and ioredis out of the bundler —
 *    they use dynamic requires and worker threads that the bundler breaks.
 */
const isProduction = process.env.NODE_ENV === 'production';

/**
 * The Windows desktop build serves the dashboard over plain http on loopback.
 * HSTS and `upgrade-insecure-requests` are right for a hosted deployment and
 * would break that, so they are skipped when this flag was set at build time.
 */
const isDesktop = process.env.WEBSCRAPER_DESKTOP === '1';
const secureTransport = isProduction && !isDesktop;
const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Hosts allowed to reach the dev server. The sandbox that runs this checkout
 * serves the app from a generated `*.e2b.app` hostname, and Next's dev server
 * rejects cross-origin requests it does not recognise — which would silently
 * break the live preview (HMR and fetches) while the page itself renders.
 */
const allowedDevOrigins = ['*.e2b.app', 'localhost', '127.0.0.1'];

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next injects inline scripts; 'unsafe-inline' is required for the App Router
  // bootstrap and is scoped to scripts only.
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // The browser talks to this origin and to Supabase Realtime; nothing else.
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co${isProduction ? '' : ' ws: http://localhost:3000'}`,
  // Scraped pages are rendered in a sandboxed iframe from our own origin.
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  secureTransport ? 'upgrade-insecure-requests' : '',
]
  .filter(Boolean)
  .join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `@webscraper/shared` is deliberately NOT in `transpilePackages`, and there
  // is no tsconfig path mapping for it: the package is consumed as compiled ESM
  // from `packages/shared/dist`. Turbopack does not rewrite the `.js`
  // specifiers tsc emits (`./constants.js` → `constants.ts`), so bundling the
  // sources fails outright. `tsc --noEmit` checks the same compiled
  // declarations, which is why the root scripts build shared first.
  serverExternalPackages: ['bullmq', 'ioredis'],
  // Desktop builds ship a self-contained server (`.next/standalone`); the
  // tracing root is the monorepo so the compiled `@webscraper/shared` is included.
  ...(isDesktop ? { output: 'standalone' as const, outputFileTracingRoot: monorepoRoot } : {}),
  allowedDevOrigins,

  experimental: {
    // Server Actions are used for form submissions in the wizard.
    serverActions: { bodySizeLimit: '4mb' },
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(secureTransport
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
            : []),
        ],
      },
      {
        // API responses are never cached by a proxy: they are per-tenant.
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

export default nextConfig;
