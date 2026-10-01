import { configurationWarnings, features } from '@/lib/env';
import { engineHealthOrNull } from '@/lib/engine';
import { jsonOk, route } from '@/lib/api';

/**
 * Capability + health report for the UI's status pill.
 *
 * Unauthenticated on purpose: it returns only capability booleans and the
 * engine's own public version string — never tenant data, counts or config.
 */
export const GET = route(async () => {
  const engineHealth = await engineHealthOrNull();

  return jsonOk({
    app: {
      status: 'ok',
      demoMode: features.demoMode,
      ai: features.ai,
      redis: features.redis,
      supabase: features.supabase,
      warnings: configurationWarnings(),
    },
    engine: engineHealth
      ? {
          status: engineHealth.status,
          version: engineHealth.version,
          browserAvailable: engineHealth.browserAvailable,
          aiEnabled: engineHealth.aiEnabled,
          redisAvailable: engineHealth.redisAvailable,
        }
      : { status: 'unreachable', version: null, browserAvailable: false, aiEnabled: false, redisAvailable: false },
  });
});
