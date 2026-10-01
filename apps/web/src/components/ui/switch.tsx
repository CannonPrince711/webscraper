'use client';

import { cn } from '@webscraper/shared';

/**
 * Switch.
 *
 * A real `<button role="switch">` with `aria-checked`, not a styled checkbox:
 * screen readers announce the state, and the whole control is a 36×20px hit
 * target instead of a 14px box.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        checked ? 'border-primary bg-primary' : 'border-border bg-surface-sunken',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}
