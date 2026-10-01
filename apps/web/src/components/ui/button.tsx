import { cn } from '@webscraper/shared';
import type { ButtonHTMLAttributes } from 'react';

/**
 * Button.
 *
 * Variants are semantic (`primary`, `danger`) rather than visual (`blue`), so a
 * theme change is a palette change, not a find-and-replace. Every variant keeps
 * a visible focus ring and a disabled state that does not rely on colour alone.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover border border-transparent',
  secondary: 'bg-surface text-foreground border border-border hover:border-border-strong hover:bg-surface-raised',
  ghost: 'bg-transparent text-muted-foreground hover:bg-surface-sunken hover:text-foreground border border-transparent',
  danger: 'bg-danger text-white hover:opacity-90 border border-transparent',
  subtle: 'bg-surface-sunken text-foreground border border-transparent hover:border-border',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ className, variant = 'secondary', size = 'md', type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex select-none items-center rounded-lg font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
