'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, Plug, XCircle } from 'lucide-react';
import type { EngineProxyCheck } from '@webscraper/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

/**
 * "Test connection" for a proxy policy.
 *
 * The failure states are the point of this component. A proxy misconfiguration
 * produces four different errors that all look alike in a fetch log — missing
 * key, wrong password (407), wrong host, blocked port — and each one has a
 * different fix. So the card renders the engine's message and hint verbatim
 * instead of collapsing everything into "proxy failed".
 */
export function ProxyTestCard({
  decodoConfigured,
  decodoEndpoint,
  staticPoolSize,
}: {
  decodoConfigured: boolean;
  decodoEndpoint: string | null;
  staticPoolSize: number;
}) {
  const [policy, setPolicy] = useState(decodoConfigured ? 'decodo' : '');
  const [result, setResult] = useState<EngineProxyCheck | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setResult(null);

    try {
      const response = await fetch('/api/proxy/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: policy.trim() || null }),
      });
      setResult((await response.json()) as EngineProxyCheck);
    } catch {
      setResult({
        ok: false,
        kind: 'unknown',
        label: 'Request failed',
        configured: decodoConfigured,
        durationMs: 0,
        error: 'The request could not be sent. Is the engine running?',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
            Proxy
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Where requests leave from. Jobs choose a policy; the credential stays on the server.
          </p>
        </div>
        <Badge tone={decodoConfigured ? 'success' : 'neutral'}>
          {decodoConfigured ? 'Decodo configured' : 'Decodo not configured'}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        <dl className="grid gap-2 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="font-medium">Decodo residential</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="font-mono">{decodoEndpoint ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Static pool</dt>
            <dd className="font-medium">{staticPoolSize > 0 ? `${staticPoolSize} endpoint(s)` : 'None'}</dd>
          </div>
        </dl>

        {!decodoConfigured ? (
          <div className="rounded-lg border border-border bg-surface-sunken/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">Add your Decodo credentials to the root .env:</p>
            <pre className="mt-2 overflow-x-auto font-mono text-[11px]">
{`DECODO_USERNAME=user-yourname
DECODO_PASSWORD=your-proxy-password
DECODO_ENDPOINT=gate.decodo.com:7000
DECODO_COUNTRY=us`}
            </pre>
            <p className="mt-2">
              Copy them from Decodo → Residential → Proxy setup. Restart the engine afterwards; credentials are read
              once at startup, so the job files themselves never contain them.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field
              label="Policy to test"
              htmlFor="proxy-policy"
              hint="'decodo' for your default country, 'decodo://?country=de' to target one, or paste a proxy URL."
            >
              <Input
                id="proxy-policy"
                value={policy}
                onChange={(event) => setPolicy(event.target.value)}
                placeholder="decodo://?country=us"
                spellCheck={false}
              />
            </Field>
          </div>
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            Test connection
          </Button>
        </div>

        {result ? (
          result.ok ? (
            <div className="space-y-2 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-xs">
              <p className="flex items-center gap-2 font-medium text-success">
                <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                Traffic is leaving through the proxy
              </p>
              <dl className="grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Exit IP</dt>
                  <dd className="font-mono">{result.exitIp ?? 'unknown'}</dd>
                </div>
                {(result.country ?? result.city) ? (
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Location</dt>
                    <dd>{[result.city, result.country].filter(Boolean).join(', ')}</dd>
                  </div>
                ) : null}
                {result.isp ? (
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Network</dt>
                    <dd>{result.isp}</dd>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Round trip</dt>
                  <dd>{Math.round(result.durationMs)} ms</dd>
                </div>
              </dl>
              <p className="text-[11px] text-muted-foreground">{result.label}</p>
            </div>
          ) : (
            <div className="space-y-1 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-xs">
              <p className="flex items-center gap-2 font-medium text-danger">
                <XCircle className="h-4 w-4" strokeWidth={2} />
                {result.error ?? 'The proxy check failed.'}
              </p>
              {result.hint ? <p className="text-[11px] text-muted-foreground">{result.hint}</p> : null}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
