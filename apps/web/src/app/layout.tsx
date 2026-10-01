import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { publicEnv } from '@/lib/env';

/**
 * Root layout.
 *
 * `suppressHydrationWarning` on <html> is required by next-themes: the theme
 * class is applied before React hydrates (so there is no flash of the wrong
 * theme), which means the server HTML and client HTML legitimately differ on
 * that one attribute.
 */
export const metadata: Metadata = {
  title: {
    default: 'Webscraper',
    template: '%s · Webscraper',
  },
  description:
    'AI-powered web scraping: crawl, extract, schedule and export structured data with a declarative, versioned configuration.',
  applicationName: 'Webscraper',
  robots: { index: false, follow: false }, // an internal tool, not a public site
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#151823' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          // Without this, switching themes re-renders the whole tree and the
          // dashboard flickers on a slow connection.
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        <script
          // Supabase is optional; the client bundle reads these two public
          // values to decide whether to open a Realtime subscription. They are
          // public by definition (the anon key is protected by RLS).
          id="webscraper-public-env"
          type="application/json"
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({ supabaseUrl: publicEnv.supabaseUrl, supabaseAnonKey: publicEnv.supabaseAnonKey }),
          }}
        />
      </body>
    </html>
  );
}
