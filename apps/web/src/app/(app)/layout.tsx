import { AlertTriangle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { SidebarNav } from '@/components/app-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { configurationWarnings, features } from '@/lib/env';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * The application shell.
 *
 * It resolves the org context once, on the server, and passes nothing down:
 * every page fetches what it needs through the same store. Doing it this way
 * means an unauthenticated request fails in *one* place (the store throws
 * `unauthorized`) rather than in each page's own guard.
 *
 * The configuration banner is server-rendered from the real environment, so it
 * cannot claim "demo mode" on a deployment that is actually connected — or
 * worse, hide a missing Redis from the person who needs to know.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const store = await getStore();
  const context = await store.getOrgContext();
  const warnings = configurationWarnings();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Sparkles className="h-4 w-4" strokeWidth={2} />
              </span>
              Webscraper
            </Link>
            <span className="hidden text-xs text-muted-foreground sm:inline">{context.org.name}</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground sm:inline">
              {context.role}
            </span>
            <ThemeToggle />
            <div className="grid h-8 w-8 place-items-center rounded-full bg-surface-raised text-xs font-medium">
              {(context.user.fullName ?? context.user.email ?? 'U').slice(0, 1).toUpperCase()}
            </div>
          </div>
        </div>
      </header>

      {warnings.length > 0 ? (
        <div className="border-b border-warning/30 bg-warning/10">
          <ul className="mx-auto flex w-full max-w-[1400px] flex-col gap-1 px-4 py-2 text-xs text-foreground sm:px-6">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={2} />
                <span className="text-pretty">{warning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 gap-8 px-4 py-6 sm:px-6">
        <aside className="hidden w-52 shrink-0 lg:block">
          <div className="sticky top-20">
            <SidebarNav />
            <div className="mt-6 rounded-lg border border-border bg-surface px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {features.demoMode ? (
                <>
                  <span className="font-medium text-foreground">Demo data</span>
                  <br />
                  Stored in <code className="font-mono">.data/store.json</code> on this machine.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">Connected</span>
                  <br />
                  Postgres + RLS via Supabase.
                </>
              )}
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
