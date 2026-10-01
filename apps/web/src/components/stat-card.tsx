import { cn, formatNumber } from '@webscraper/shared';
import type { ReactNode } from 'react';

/**
 * A single KPI.
 *
 * `hint` exists because a number without context is a liability: "1,204 records"
 * means something different on day one than on day thirty, and "+18% vs last
 * week" is the part a user actually acts on.
 */
export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  icon,
  className,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  icon?: ReactNode;
  className?: string;
}) {
  const formatted = typeof value === 'number' ? formatNumber(value) : (value ?? '—');

  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-foreground';

  return (
    <div className={cn('card px-5 py-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon ? <span className="text-muted-foreground/70">{icon}</span> : null}
      </div>
      <p className={cn('mt-2 text-2xl font-semibold tabular', toneClass)}>
        {formatted}
        {unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground text-pretty">{hint}</p> : null}
    </div>
  );
}
