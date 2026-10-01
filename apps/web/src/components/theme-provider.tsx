'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

/**
 * Thin wrapper so the rest of the app never imports `next-themes` directly.
 *
 * Keeping it in one place means the theme mechanism (class vs attribute, storage
 * key, forced themes) can change without touching every component — and it gives
 * the app a single obvious answer to "how does dark mode work?".
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
