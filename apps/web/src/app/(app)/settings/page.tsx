import { AlertTriangle, CheckCircle2, KeyRound, Webhook as WebhookIcon } from 'lucide-react';
import { formatNumber, formatRelativeTime } from '@webscraper/shared';
import { ProxyTestCard } from '@/components/proxy-test-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { engineHealthOrNull } from '@/lib/engine';
import { configurationWarnings, features } from '@/lib/env';
import { getStore } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

/**
 * Settings.
 *
 * Two things are deliberately on this page rather than buried in tabs:
 *
 *  - **Configuration warnings.** Demo storage, no queue, no AI — each one
 *    changes what the product can do, and a user who cannot see them will file
 *    "my schedule never runs" as a bug.
 *  - **The proxy test.** Every proxy problem looks the same in a failed run, so
 *    the diagnostic lives one click away instead of in a support thread.
 */
export default async function SettingsPage() {
  const store = await getStore();
  const [orgContext, keys, webhooks, health] = await Promise.all([
    store.getOrgContext(),
    store.listApiKeys().catch(() => []),
    store.listWebhooks().catch(() => []),
    engineHealthOrNull(),
  ]);

  const warnings = configurationWarnings();
  const proxyChecks = (health?.checks?.proxy ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-muted-foreground">
          {orgContext.org.name} · you are signed in as {orgContext.role}
        </p>
      </div>

      {warnings.length > 0 ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" strokeWidth={1.8} />
              Configuration notices
            </CardTitle>
            <Badge tone="warning">{warnings.length}</Badge>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {warnings.map((warning) => (
                <li key={warning} className="flex gap-2">
                  <span aria-hidden className="text-warning">
                    •
                  </span>
                  {warning}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Scraping engine</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The Python service that fetches and parses pages.
            </p>
          </div>
          <Badge tone={health ? 'success' : 'danger'}>{health ? 'Reachable' : 'Unreachable'}</Badge>
        </CardHeader>
        <CardContent>
          {health ? (
            <dl className="grid gap-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Version</dt>
                <dd className="font-medium">{health.version}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Browser rendering</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  {health.browserAvailable ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Available
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 text-warning" /> Not installed
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">AI provider</dt>
                <dd className="font-medium">{health.aiEnabled ? 'Configured' : 'Heuristic mode'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Uptime</dt>
                <dd className="font-medium">{Math.round(health.uptimeSeconds / 60)} min</dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              The engine is not answering at its configured URL. Jobs will fail until it is running:
              <code className="mx-1 rounded bg-surface-sunken px-1.5 py-0.5 font-mono">npm run dev:engine</code>
            </p>
          )}
        </CardContent>
      </Card>

      <ProxyTestCard
        decodoConfigured={Boolean(proxyChecks.decodo_configured)}
        decodoEndpoint={typeof proxyChecks.decodo_endpoint === 'string' ? proxyChecks.decodo_endpoint : null}
        staticPoolSize={typeof proxyChecks.static_pool_size === 'number' ? proxyChecks.static_pool_size : 0}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
                API keys
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                For scripts and integrations. Secrets are shown once and stored hashed.
              </p>
            </div>
            <Badge>{keys.filter((key) => !key.revoked_at).length} active</Badge>
          </CardHeader>
          <CardContent>
            {keys.length === 0 ? (
              <EmptyState
                icon={<KeyRound className="h-5 w-5" strokeWidth={1.5} />}
                title="No API keys"
                description="Create one to call the REST API from a script: POST /api/keys with a name and scopes returns the secret exactly once."
              />
            ) : (
              <ul className="divide-y divide-border text-xs">
                {keys.slice(0, 6).map((key) => (
                  <li key={key.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{key.name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {key.prefix}…  ·  {key.scopes.join(', ')}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                      <p>{formatNumber(key.request_count)} requests</p>
                      <p>{key.revoked_at ? 'revoked' : `used ${formatRelativeTime(key.last_used_at)}`}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <WebhookIcon className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
                Webhooks
              </CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Run events are POSTed with an HMAC-SHA256 signature you can verify.
              </p>
            </div>
            <Badge>{webhooks.filter((hook) => hook.is_active).length} active</Badge>
          </CardHeader>
          <CardContent>
            {webhooks.length === 0 ? (
              <EmptyState
                icon={<WebhookIcon className="h-5 w-5" strokeWidth={1.5} />}
                title="No webhooks"
                description="Get notified when a run finishes or fails, instead of polling the API."
              />
            ) : (
              <ul className="divide-y divide-border text-xs">
                {webhooks.slice(0, 6).map((hook) => (
                  <li key={hook.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px]">{hook.url}</p>
                      <p className="text-[11px] text-muted-foreground">{hook.events.join(', ')}</p>
                    </div>
                    <Badge tone={hook.is_active ? 'success' : 'neutral'}>{hook.is_active ? 'active' : 'paused'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Storage: {features.demoMode ? 'local JSON file (demo mode)' : 'Supabase'} · Queue:{' '}
        {features.redis ? 'Redis / BullMQ' : 'inline in the web process'}
      </p>
    </div>
  );
}
