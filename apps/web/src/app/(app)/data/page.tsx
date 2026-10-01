import Link from 'next/link';
import { Database, Download, Search } from 'lucide-react';
import { describeProxy, formatNumber, formatRelativeTime } from '@webscraper/shared';
import { RunButton } from '@/components/run-button';
import { StatusPill } from '@/components/status-pill';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Data' };

const PAGE_SIZE = 25;

/**
 * Data explorer.
 *
 * Server-rendered on purpose. The rows are already in Postgres (or the demo
 * JSON store); shipping a client-side grid would mean fetching the same data
 * twice — once for the HTML, once for hydration — to save a page load that the
 * user has already waited for.
 *
 * Every filter is a URL parameter, so a filtered view is a link someone can
 * paste into a ticket, and the browser's back button behaves.
 */
export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; q?: string; changed?: string; page?: string }>;
}) {
  const params = await searchParams;
  const store = await getStore();

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const [jobs, records] = await Promise.all([
    store.listJobs({ limit: 200 }),
    store
      .listRecords({
        jobId: params.job,
        search: params.q,
        changedOnly: params.changed === '1',
        page,
        pageSize: PAGE_SIZE,
        sort: 'newest',
      })
      .catch(() => ({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE, hasMore: false })),
  ]);

  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const columns = records.items.length > 0 ? Object.keys(records.items[0]?.data ?? {}).slice(0, 8) : [];

  function href(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams();
    const merged = { job: params.job, q: params.q, changed: params.changed, page: undefined, ...patch };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    const query = next.toString();
    return query ? `/data?${query}` : '/data';
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Data</h1>
          <p className="text-xs text-muted-foreground">
            {formatNumber(records.total)} record{records.total === 1 ? '' : 's'}
            {params.job ? ` in ${jobsById.get(params.job)?.name ?? 'this job'}` : ' across all jobs'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/api/records/export?format=csv${params.job ? `&jobId=${encodeURIComponent(params.job)}` : ''}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-border-strong"
            prefetch={false}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
            CSV
          </Link>
          <Link
            href={`/api/records/export?format=jsonl${params.job ? `&jobId=${encodeURIComponent(params.job)}` : ''}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-border-strong"
            prefetch={false}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
            JSONL
          </Link>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 py-4">
          <form action="/data" className="flex flex-1 flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor="data-search" className="mb-1.5 block text-xs font-medium">
                Search
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="data-search"
                  name="q"
                  defaultValue={params.q ?? ''}
                  placeholder="Search extracted values…"
                  className="pl-8"
                />
              </div>
            </div>

            <div>
              <label htmlFor="data-job" className="mb-1.5 block text-xs font-medium">
                Job
              </label>
              <select
                id="data-job"
                name="job"
                defaultValue={params.job ?? ''}
                className="h-9 w-52 rounded-lg border border-border bg-surface px-3 text-sm focus:border-primary focus:outline-none"
              >
                <option value="">All jobs</option>
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex h-9 items-center gap-2 text-xs">
              <input type="checkbox" name="changed" value="1" defaultChecked={params.changed === '1'} />
              Changed since last run
            </label>

            <button
              type="submit"
              className="h-9 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              Filter
            </button>
          </form>
        </CardContent>
      </Card>

      {records.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Database className="h-6 w-6" strokeWidth={1.5} />}
            title="No records yet"
            description="Records appear here after a job runs. Extracted rows are deduplicated by content hash, so a re-run only creates a new version when something actually changed."
            action={
              jobs.length > 0 && jobs[0] ? <RunButton jobId={jobs[0].id} label="Run the first job" size="md" /> : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-surface-sunken/60 text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  {columns.map((column) => (
                    <th key={column} className="px-4 py-2 font-medium">
                      {column}
                    </th>
                  ))}
                  <th className="px-4 py-2 font-medium">Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.items.map((record) => {
                  const job = jobsById.get(record.job_id);
                  return (
                    <tr key={record.id} className="align-top hover:bg-surface-sunken/40">
                      <td className="whitespace-nowrap px-4 py-2">
                        <span className="flex items-center gap-2">
                          <StatusPill status={job?.status ?? 'draft'} />
                          <Link href={`/jobs/${record.job_id}`} className="hover:underline">
                            {job?.name ?? 'Deleted job'}
                          </Link>
                        </span>
                      </td>
                      <td className="max-w-56 truncate px-4 py-2 font-mono text-[11px] text-muted-foreground">
                        {record.source_url ? (
                          <a href={record.source_url} target="_blank" rel="noreferrer noopener" className="hover:underline">
                            {record.source_url}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      {columns.map((column) => (
                        <td key={column} className="max-w-56 truncate px-4 py-2">
                          {formatCell(record.data[column])}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-4 py-2 text-[11px] text-muted-foreground">
                        <div className="flex flex-col gap-1">
                          <span>{formatRelativeTime(record.last_seen_at ?? record.updated_at)}</span>
                          {record.is_changed ? (
                            <Badge tone="warning" title="This row differs from the previous version">
                              changed
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {page > 1 || records.hasMore ? (
            <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
              <span>
                Page {page} · showing {records.items.length} of {formatNumber(records.total)}
              </span>
              <div className="flex gap-2">
                {page > 1 ? (
                  <Link href={href({ page: String(page - 1) })} className="hover:underline">
                    Previous
                  </Link>
                ) : null}
                {records.hasMore ? (
                  <Link href={href({ page: String(page + 1) })} className="hover:underline">
                    Next
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      )}

      {jobs.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Egress for the first job:{' '}
          {describeProxy(jobs[0]?.config.fetch.proxy ?? null).label} ·{' '}
          {describeProxy(jobs[0]?.config.fetch.proxy ?? null).detail}
        </p>
      ) : null}
    </div>
  );
}

/** Render a value without pretending to know its type. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
