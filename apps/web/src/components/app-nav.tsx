'use client';

import { cn } from '@webscraper/shared';
import { BarChart3, Database, Plus, Settings, Table2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Primary navigation.
 *
 * A client component only because it needs `usePathname` to mark the active
 * section; everything else in the shell is server-rendered. `aria-current` is
 * set for assistive technology rather than relying on colour alone.
 */
const LINKS = [
  { href: '/dashboard', label: 'Dashboard', Icon: BarChart3 },
  { href: '/jobs', label: 'Jobs', Icon: Table2 },
  { href: '/data', label: 'Data', Icon: Database },
  { href: '/settings', label: 'Settings', Icon: Settings },
] as const;

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {LINKS.map(({ href, label, Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-surface-raised font-medium text-foreground'
                : 'text-muted-foreground hover:bg-surface-raised/60 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            {label}
          </Link>
        );
      })}

      <Link
        href="/jobs/new"
        className="mt-3 flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      >
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        New job
      </Link>
    </nav>
  );
}
