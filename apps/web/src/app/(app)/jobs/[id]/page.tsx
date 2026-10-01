import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarClock, ExternalLink } from 'lucide-react';
import {
  EXTRACT_STRATEGY_HELP,
  RENDER_MODE_HELP,
  describeCron,
  describeProxy,
  formatBytes,
  formatNumber,
  formatRelativeTime,
} from '@webscraper/shared';
import { RunButton } from '@/components/run-button';
import { StatusPill } from '@/components/status-pill';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Job detail.
 *
 * The config is rendered as a read-only summary rather than a form. The wizard
 * owns editing, and having two editors for one validated document is how the
 * two drift apart. What this page adds is *evidence*: did the last run work,
 * what did it cost, and where did the traffic come from.
 */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await getStore();
  const job = await store.getJob(id);

  if (!job) notFound();

  const runs = await store.listRuns(id, 12);
  const config = job.config;
  const proxy = describeProxy(config.fetch.proxy);
  const lastRun = runs[0];

  const facts: Array<{ label: string; value: string; hint?: string }> = [
    { label: 'Mode', value: config.mode },
    {
      label: 'Rendering',
      value: config.fetch.render === 'auto' ? 'Automatic' : config.fetch.render === 'js' ? 'Browser' : 'HTTP only',
      hint: RENDER_MODE_HELP[config.fetch.render]?.split('.')[0],
    },
    { label: 'Egress', value: proxy.label, hint: proxy.detail },
    { label: 'robots.txt', value: config.fetch.respectRobots ? 'Respected' : 'Ignored' },
    {
      label: 'Extraction',
      value: config.extract.strategy,
      hint: EXTRACT_STRATEGY_HELP[config.extract.strategy]?.split('.')[0],
    },
    { label: 'Fields', value: config.extract.fields.length > 0 ? config.extract.fields.map((field) => field.name).join(', ') : 'Detected automatically' },
    { label: 'Pages per run', value: formatNumber(config.limits.maxPages) },
    { label: 'Duration limit', value: `${Math.round(config.limits.maxDurationMs / 60_000)} min` },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link href="/jobs" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:underline">
            <ArrowLeft className="h-3 w-3" />
            All jobs
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
            {job.name}
            <StatusPill status={job.status} />
            <Badge>{config.mode}</Badge>
          </h1>
          <p className="text-xs text-muted-foreground">
            {formatNumber(job.record_count)} records · {job.run_count} runs · created {formatRelativeTime(job.created_at)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/data?job=${job.id}`}
            className="rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-border-strong"
          >
            View data
          </Link>
          <RunButton jobId={job.id} size="md" label="Run now" />
        </div>
      </div>

      {job.schedule_enabled && job.schedule_cron ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
            <span className="flex items-center gap-2">
              <CalendarClock className="h-3.5 w-3.5 text-primary" strokeWidth={1.8} />
              {describeCron(job.schedule_cron)} · {job.schedule_tz ?? 'UTC'}
            </span>
            <span className="text-muted-foreground">
              Next run {job.next_run_at ? new Date(job.next_run_at).toLocaleString() : 'not scheduled'}
            </span>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <Badge>v{String(config.meta.version ?? 1)}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              {facts.map((fact) => (
                <div key={fact.label}>
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="font-medium" title={fact.hint}>
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>

            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Targets ({config.targets.length})
              </p>
              <ul className="space-y-1">
                {config.targets.slice(0, 10).map((target) => (
                  <li key={target} className="truncate font-mono text-[11px]">
                    <a href={target} target="_blank" rel="noreferrer noopener" className="hover:underline">
                      {target}
                    </a>
                  </li>
                ))}
                {config.targets.length > 10 ? (
                  <li className="text-[11px] text-muted-foreground">+{config.targets.length - 10} more</li>
                ) : null}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Last run</CardTitle>
            {lastRun ? <StatusPill status={lastRun.status} /> : null}
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            {lastRun ? (
              <>
                <dl className="space-y-2">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Started</dt>
                    <dd>{formatRelativeTime(lastRun.started_at)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Duration</dt>
                    <dd>{lastRun.duration_ms ? `${(lastRun.duration_ms / 1000).toFixed(1)}s` : '—'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Pages</dt>
                    <dd>
                      {lastRun.pages_ok} ok · {lastRun.pages_failed} failed
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Records</dt>
                    <dd>
                      {lastRun.records_count} total · {lastRun.records_new} new
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Downloaded</dt>
                    <dd>{formatBytes(lastRun.bytes_downloaded)}</dd>
                  </div>
                  {lastRun.ai_tokens_used > 0 ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">AI tokens</dt>
                      <dd>
                        {formatNumber(lastRun.ai_tokens_used)} · ${lastRun.ai_cost_usd.toFixed(4)}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {lastRun.error_message ? (
                  <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                    {lastRun.error_message}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">This job has not run yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run history</CardTitle>
          <Badge>{runs.length}</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="px-5 py-4 text-xs text-muted-foreground">Nothing here yet — start a run to see it recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-surface-sunken/60 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2 font-medium">Run</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Trigger</th>
                    <th className="px-4 py-2 font-medium">Pages</th>
                    <th className="px-4 py-2 font-medium">Records</th>
                    <th className="px-4 py-2 font-medium">Duration</th>
                    <th className="px-4 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((run) => (
                    <tr key={run.id} className="hover:bg-surface-sunken/40">
                      <td className="px-5 py-2 font-mono text-[11px]">#{run.run_number}</td>
                      <td className="px-4 py-2">
                        <StatusPill status={run.status} />
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{run.trigger}</td>
                      <td className="px-4 py-2">
                        {run.pages_ok}
                        {run.pages_failed > 0 ? <span className="text-warning"> (+{run.pages_failed} failed)</span> : null}
                      </td>
                      <td className="px-4 py-2">
                        {run.records_count}
                        {run.records_new > 0 ? <span className="text-success"> (+{run.records_new} new)</span> : null}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatRelativeTime(run.started_at ?? run.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {job.status === 'failed' && lastRun?.error_message ? (
        <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
          Failed runs keep their log entries on the run record, so a support ticket can quote the exact page that broke
          without re-running the crawl.
        </p>
      ) : null}
    </div>
  );
}
