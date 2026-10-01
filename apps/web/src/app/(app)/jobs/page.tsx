import Link from 'next/link';
import { CalendarClock, Globe, Plus } from 'lucide-react';
import { describeCron, formatNumber, formatRelativeTime, RENDER_MODE_HELP } from '@webscraper/shared';
import { RunButton } from '@/components/run-button';
import { StatusPill } from '@/components/status-pill';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Jobs' };

/**
 * Job list.
 *
 * Sorted by "what needs my attention": running first, then failing, then
 * everything else by recency. A list sorted purely by creation date hides the
 * broken job behind the newest draft.
 */
const STATUS_ORDER: Record<string, number> = { running: 0, queued: 1, failed: 2, partial: 3, paused: 4, draft: 5, succeeded: 6, cancelled: 7 };

export default async function JobsPage() {
  const store = await getStore();
  const jobs = await store.listJobs({ limit: 100 });

  const sorted = [...jobs].sort((a, b) => {
    const rank = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
    if (rank !== 0) return rank;
    return (b.last_run_at ?? b.created_at).localeCompare(a.last_run_at ?? a.created_at);
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Jobs</h1>
          <p className="text-xs text-muted-foreground">
            {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} in this workspace
          </p>
        </div>
        <Link
          href="/jobs/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          New job
        </Link>
      </div>

      {sorted.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Globe className="h-6 w-6" strokeWidth={1.5} />}
            title="No jobs yet"
            description="A job is a target plus rules: what to fetch, what to extract, and how often. Create one to get started."
            action={
              <Link
                href="/jobs/new"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm hover:border-border-strong"
              >
                <Plus className="h-4 w-4" strokeWidth={2} />
                Create the first job
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {sorted.map((job) => {
            const config = job.config;
            const mode = config.mode;

            return (
              <Card key={job.id} className="card-hover">
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/jobs/${job.id}`} className="truncate text-sm font-medium hover:underline">
                        {job.name}
                      </Link>
                      <StatusPill status={job.status} />
                      <Badge>{mode}</Badge>
                      {job.schedule_enabled && job.schedule_cron ? (
                        <Badge tone="primary">
                          <CalendarClock className="h-3 w-3" strokeWidth={2} />
                          {describeCron(job.schedule_cron)}
                        </Badge>
                      ) : null}
                    </div>

                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {config.targets.slice(0, 2).join('  ·  ')}
                      {config.targets.length > 2 ? `  ·  +${config.targets.length - 2} more` : ''}
                    </p>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>
                        {formatNumber(job.record_count)} records over {job.run_count} runs
                      </span>
                      <span>
                        fetch: {RENDER_MODE_HELP[config.fetch.render]?.split('.')[0] ?? config.fetch.render}
                      </span>
                      <span>
                        limits: {formatNumber(config.limits.maxPages)} pages / {Math.round(config.limits.maxDurationMs / 60000)} min
                      </span>
                      <span>last run {formatRelativeTime(job.last_run_at)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-border-strong"
                    >
                      Open
                    </Link>
                    <RunButton jobId={job.id} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
