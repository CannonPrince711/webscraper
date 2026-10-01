import { safeRecord } from '@webscraper/shared';
import { boolParam, intParam, jsonOk, route } from '@/lib/api';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Record search.
 *
 * Two things worth noting:
 *
 *  - **Records are returned through `safeRecord`.** Extracted keys come from a
 *    hostile page; stripping `__proto__`/`constructor` here means a malicious
 *    site cannot pollute `Object.prototype` in a consumer that spreads records.
 *  - **Pagination is server-side and capped.** The reporter's instinct is
 *    "select all"; that is how a dashboard takes a database down.
 */
export const GET = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();
  const url = new URL(request.url);

  await enforceRateLimit(`records:${context.org.id}`, { max: 300, windowMs: 60_000 });

  const result = await store.listRecords({
    jobId: url.searchParams.get('jobId') ?? undefined,
    search: url.searchParams.get('q')?.trim().slice(0, 200) || undefined,
    changedOnly: boolParam(url.searchParams.get('changed')),
    page: intParam(url.searchParams.get('page'), 1, 1, 10_000),
    pageSize: intParam(url.searchParams.get('pageSize'), 50, 1, 200),
    sort: (url.searchParams.get('sort') as 'newest' | 'oldest' | 'position' | null) ?? 'newest',
  });

  return jsonOk({
    ...result,
    items: result.items.map((row) => ({
      ...row,
      data: safeRecord(row.data as Record<string, unknown>),
      enriched: row.enriched ? safeRecord(row.enriched as Record<string, unknown>) : null,
    })),
  });
});
