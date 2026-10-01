'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@webscraper/shared';

/**
 * Light / dark / system switch.
 *
 * Rendered as a three-way segmented control rather than a two-state toggle:
 * "follow my OS" is a legitimate preference, and a toggle that silently
 * overrides it is a small but constant annoyance.
 */
const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The server cannot know the user's theme, so render a stable placeholder
  // until hydration. Rendering the real control immediately causes a mismatch.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className={cn('h-8 w-[104px] rounded-lg border border-border bg-surface-sunken', className)} aria-hidden />;
  }

  return (
    <div
      className={cn('inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5', className)}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
            <span className="sr-only-focusable">{label}</span>
          </button>
        );
      })}
      <span className="sr-only" aria-live="polite">
        {resolvedTheme === 'dark' ? 'Dark theme is active' : 'Light theme is active'}
      </span>
    </div>
  );
}
