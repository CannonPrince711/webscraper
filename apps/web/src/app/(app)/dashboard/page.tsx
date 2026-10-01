import { Suspense } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowUpRight, CheckCircle2, Database, FileWarning, Gauge } from 'lucide-react';
import { formatDuration, formatNumber, formatRelativeTime } from '@webscraper/shared';
import { EngineStatus } from '@/components/engine-status';
import { Sparkline } from '@/components/sparkline';
import { StatCard } from '@/components/stat-card';
import { StatusPill } from '@/components/status-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

/**
 * Dashboard.
 *
 * Everything here is read through the store, which means RLS (or the demo
 * store's single tenant) decides what the numbers cover — the page never filters
 * by org itself.
 *
 * `EngineStatus` is the only thing that talks to the network, and it is behind
 * Suspense so the page renders while the engine is being probed.
 */
export default async function DashboardPage() {
  const store = await getStore();
  const [stats, recentRuns, jobs] = await Promise.all([
    store.dashboardStats(),
    store.listRecentRuns(8),
    store.listJobs({ limit: 6 }),
  ]);

  const attention = jobs.filter((job) => job.status === 'failed' || job.status === 'partial');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            {stats.activeJobs} active {stats.activeJobs === 1 ? 'job' : 'jobs'} · {formatNumber(stats.totalRecords)} records total
          </p>
        </div>
        <Link
          href="/jobs/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          New job
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Records"
          value={stats.totalRecords}
          hint={`${formatNumber(stats.recordsToday)} collected today`}
          icon={<Database className="h-4 w-4" strokeWidth={1.75} />}
        />
        <StatCard
          label="Runs today"
          value={stats.runsToday}
          hint={`${stats.failedToday} failed`}
          tone={stats.failedToday > 0 ? 'warning' : 'default'}
          icon={<Gauge className="h-4 w-4" strokeWidth={1.75} />}
        />
        <StatCard
          label="Success rate"
          value={`${Math.round(stats.successRate * 100)}%`}
          hint="Across the last 30 days of runs"
          tone={stats.successRate >= 0.95 ? 'success' : stats.successRate >= 0.8 ? 'warning' : 'danger'}
          icon={<CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />}
        />
        <StatCard
          label="Median run"
          value={stats.avgDurationMs ? formatDuration(stats.avgDurationMs) : '—'}
          hint={`${formatNumber(stats.pagesToday)} pages fetched today`}
          icon={<AlertCircle className="h-4 w-4" strokeWidth={1.75} />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Records collected</CardTitle>
              <p className="text-xs text-muted-foreground">Last {stats.throughput.length} days</p>
            </div>
            <span className="text-xs text-muted-foreground tabular">
              peak {formatNumber(Math.max(0, ...stats.throughput.map((point) => point.records)))}
            </span>
          </CardHeader>
          <CardContent>
            <Sparkline points={stats.throughput.map((point) => point.records)} label="Records per day" className="h-24 w-full" />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Suspense fallback={<Skeleton className="h-[62px] w-full rounded-lg" />}>
            <EngineStatus />
          </Suspense>

          <Card>
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {attention.length === 0 ? (
                <p className="py-4 text-xs text-muted-foreground">
                  Nothing failing. Jobs that error or partially fail appear here.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {attention.map((job) => (
                    <li key={job.id} className="flex items-center justify-between gap-3 py-2.5">
                      <Link href={`/jobs/${job.id}`} className="truncate text-xs hover:underline">
                        {job.name}
                      </Link>
                      <StatusPill status={job.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <Link href="/jobs" className="text-xs text-muted-foreground hover:text-foreground">
            All jobs →
          </Link>
        </CardHeader>
        <CardContent className="px-0 py-0">
          {recentRuns.length === 0 ? (
            <EmptyState
              icon={<FileWarning className="h-5 w-5" strokeWidth={1.5} />}
              title="No runs yet"
              description="Create a job and start a run; progress and results appear here."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Run</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 font-medium">Pages</th>
                    <th className="px-5 py-2.5 font-medium">Records</th>
                    <th className="px-5 py-2.5 font-medium">Duration</th>
                    <th className="px-5 py-2.5 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="hover:bg-surface-raised/50">
                      <td className="px-5 py-2.5 font-mono text-[11px]">
                        <Link href={`/jobs/${run.job_id}?run=${run.id}`} className="hover:underline">
                          #{run.run_number}
                        </Link>
                      </td>
                      <td className="px-5 py-2.5">
                        <StatusPill status={run.status} />
                      </td>
                      <td className="px-5 py-2.5 tabular text-muted-foreground">
                        {run.pages_ok}/{run.pages_total}
                        {run.pages_failed > 0 ? <span className="ml-1 text-danger">−{run.pages_failed}</span> : null}
                      </td>
                      <td className="px-5 py-2.5 tabular text-muted-foreground">
                        {formatNumber(run.records_count)}
                        {run.records_changed > 0 ? (
                          <span className="ml-1 text-warning">+{run.records_changed} changed</span>
                        ) : null}
                      </td>
                      <td className="px-5 py-2.5 tabular text-muted-foreground">
                        {run.duration_ms ? formatDuration(run.duration_ms) : '—'}
                      </td>
                      <td className="px-5 py-2.5 text-muted-foreground">{formatRelativeTime(run.started_at ?? run.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
