import { jsonOk, route } from '@/lib/api';
import { engineHealthOrNull } from '@/lib/engine';
import { configurationWarnings, features } from '@/lib/env';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Everything the dashboard needs, in one request.
 *
 * One endpoint rather than five is a deliberate choice: the dashboard renders a
 * single picture, and five parallel requests from one browser tab produce five
 * authorisation checks, five rate-limit increments and five chances to render a
 * half-empty page.
 *
 * Engine health is included but degrades to `null` — an unreachable scraper
 * must never stop the dashboard from loading. Warnings are included so the demo
 * banner is driven by the server's actual configuration rather than a guess.
 */
export const GET = route(async () => {
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  await enforceRateLimit(`stats:${orgContext.org.id}`, { max: 240, windowMs: 60_000 });

  const [stats, recentRuns, usage, engine] = await Promise.all([
    store.dashboardStats(),
    store.listRecentRuns(12),
    store.listUsage(14),
    engineHealthOrNull(),
  ]);

  // Metered spend for the current month, computed from usage events rather than
  // tracked separately — one source of truth means one place to fix a bug.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthly = usage.filter((event) => Date.parse(event.occurred_at) >= monthStart.getTime());

  const aiTokensThisMonth = await store.aiTokensThisMonth();

  return jsonOk({
    stats,
    recentRuns,
    usage,
    engine: engine
      ? {
          status: engine.status,
          version: engine.version,
          browserAvailable: engine.browserAvailable,
          aiEnabled: engine.aiEnabled,
          redisAvailable: engine.redisAvailable,
          uptimeSeconds: engine.uptimeSeconds,
        }
      : null,
    quota: {
      /** Pages actually fetched this month, from usage events. */
      pagesThisMonth: monthly
        .filter((event) => event.kind === 'page_fetch' || event.kind === 'browser_render')
        .reduce((total, event) => total + event.quantity, 0),
      maxPagesPerJob: orgContext.org.limits.maxPagesPerJob,
      maxCrawlDepth: orgContext.org.limits.maxCrawlDepth,
      requestsPerMinute: orgContext.org.limits.requestsPerMinute,
      retentionDays: orgContext.org.limits.retentionDays,
      aiTokensThisMonth,
      aiTokensLimit: orgContext.org.limits.aiTokensPerMonth,
    },
    capabilities: {
      supabase: features.supabase,
      redis: features.redis,
      ai: features.ai,
      serviceRole: features.serviceRole,
      demoMode: features.demoMode,
    },
    warnings: configurationWarnings(),
    role: orgContext.role,
  });
});
