import { cn } from '@webscraper/shared';

/** Loading placeholder. Widths are explicit so a skeleton reads as content. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4 w-full', className)} aria-hidden />;
}
