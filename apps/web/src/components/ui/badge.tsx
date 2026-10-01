import { cn } from '@webscraper/shared';
import type { HTMLAttributes } from 'react';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-muted-foreground border-border',
  primary: 'bg-primary/10 text-primary border-primary/30',
  success: 'bg-success/10 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  danger: 'bg-danger/10 text-danger border-danger/30',
};

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
