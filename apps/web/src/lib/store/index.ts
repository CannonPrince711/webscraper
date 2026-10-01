import 'server-only';
import { cache } from 'react';
import { features } from '../env';
import { logger } from '../logger';
import { DemoStore } from './demo';
import { createSupabaseStore } from './supabase';
import type { Store } from './types';

/**
 * Store resolution.
 *
 * `getStore()` is wrapped in React's `cache()` so a single request — which may
 * render a dozen components that each need job data — creates one store and,
 * more importantly, resolves the session once rather than once per component.
 */
export const getStore = cache(async (): Promise<Store> => {
  if (features.supabase) {
    try {
      return await createSupabaseStore();
    } catch (error) {
      if (features.demoMode) throw error;
      logger.exception('Falling back to the demo store: Supabase client creation failed', error);
      return new DemoStore();
    }
  }
  return new DemoStore();
});

export { DemoStore } from './demo';
export { SupabaseStore } from './supabase';
export { QUERY_LIMITS } from './types';
export type { Store } from './types';
