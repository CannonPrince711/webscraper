import { cn, statusPresentation } from '@webscraper/shared';

/**
 * Status pill for jobs, runs and pages.
 *
 * Presentation comes from `statusPresentation()` in `@webscraper/shared`, which
 * is the same table the API uses to describe a status — so a status added to the
 * type system cannot render as an unstyled string here.
 */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const presentation = statusPresentation(status);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5',
        presentation.className,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', presentation.dotClassName)} aria-hidden />
      {presentation.label}
    </span>
  );
}
