import { cn } from '@webscraper/shared';
import type { ReactNode } from 'react';

/**
 * Empty states are part of the product, not an afterthought: every list here
 * can legitimately be empty on a new account, and a blank panel gives the user
 * nothing to do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
      {icon ? <div className="text-muted-foreground/70">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="max-w-md text-xs text-muted-foreground text-pretty">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
