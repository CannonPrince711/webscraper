'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, RotateCw, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { DesktopStatus } from '@/lib/desktop';
import type { SettingVar } from '@/lib/settings-vars';

interface VariableRow extends SettingVar {
  isSet: boolean;
  value: string | null;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

/** Wait for the restarted app to answer again, then reload the page. */
async function restartAndReload(): Promise<void> {
  await fetch('/api/desktop/action', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action: 'restart' }) }).catch(
    () => undefined,
  );
  const deadline = Date.now() + 60_000;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch {
      /* still restarting */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

export function EnvVariablesCard() {
  const [rows, setRows] = useState<VariableRow[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirtySaved, setDirtySaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/env', { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = (await response.json()) as { variables: VariableRow[] };
      setRows(body.variables);
      setEdits({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, VariableRow[]>();
    for (const row of rows ?? []) map.set(row.group, [...(map.get(row.group) ?? []), row]);
    return [...map.entries()];
  }, [rows]);

  const changed = Object.keys(edits).length;

  async function save(restart: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/settings/env', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ values: edits }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setDirtySaved(true);
      await load();
      if (restart) await restartAndReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
            Variables
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stored in the <code className="font-mono">data/.env</code> file next to the app. Secrets are write-only.
          </p>
        </div>
        {dirtySaved && changed === 0 ? <Badge tone="warning">Restart to apply</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-6">
        {rows === null && !error ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {groups.map(([group, items]) => (
          <section key={group} className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((item) => {
                const edited = edits[item.key];
                if (item.kind === 'bool') {
                  const raw = edited ?? item.value ?? '';
                  const unset = raw === '';
                  const current = (unset ? (item.defaultValue ?? 'false') : raw) === 'true';
                  return (
                    <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
                      <div>
                        <p className="text-xs font-medium">{item.label}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {item.key}
                          {unset ? ' · default' : ''}
                        </p>
                        {item.hint ? <p className="mt-1 text-[11px] text-muted-foreground">{item.hint}</p> : null}
                      </div>
                      <Switch
                        label={item.label}
                        checked={current}
                        onChange={(next) => setEdits((prev) => ({ ...prev, [item.key]: next ? 'true' : 'false' }))}
                      />
                    </div>
                  );
                }
                return (
                  <Field key={item.key} label={item.label} htmlFor={item.key} hint={item.hint ?? item.key}>
                    <Input
                      id={item.key}
                      type={item.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      inputMode={item.kind === 'int' ? 'numeric' : undefined}
                      placeholder={item.secret && item.isSet ? '•••••••• (set — type to replace)' : item.placeholder}
                      value={edited ?? (item.secret ? '' : (item.value ?? ''))}
                      onChange={(event) => setEdits((prev) => ({ ...prev, [item.key]: event.target.value }))}
                    />
                    {item.secret && item.isSet ? (
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground underline"
                        onClick={() => setEdits((prev) => ({ ...prev, [item.key]: '' }))}
                      >
                        Clear saved value
                      </button>
                    ) : null}
                  </Field>
                );
              })}
            </div>
          </section>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={busy || changed === 0} onClick={() => void save(false)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save{changed > 0 ? ` (${changed})` : ''}
          </Button>
          <Button disabled={busy || (changed === 0 && !dirtySaved)} onClick={() => void (changed > 0 ? save(true) : restartAndReload())}>
            <RotateCw className="h-4 w-4" /> {changed > 0 ? 'Save & restart' : 'Restart now'}
          </Button>
          <p className="text-[11px] text-muted-foreground">Changes take effect after the app restarts.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function UpdateCard() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/desktop/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      setStatus((await response.json()) as DesktopStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read update status.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(action: 'check-update' | 'install-update') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/desktop/action', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error(await errorMessage(response));
      const next = (await response.json()) as DesktopStatus;
      setStatus(next);
      if (action === 'install-update' && next.update.state === 'installing') {
        // The launcher is about to exit, swap files and relaunch itself.
        await restartAfterUpdate();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  }

  async function restartAfterUpdate() {
    const deadline = Date.now() + 120_000;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    while (Date.now() < deadline) {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (response.ok) {
          window.location.reload();
          return;
        }
      } catch {
        /* updating */
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }

  const update = status?.update;
  const tone = update?.state === 'available' ? 'primary' : update?.state === 'error' ? 'danger' : 'neutral';

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-4 w-4 text-muted-foreground" strokeWidth={1.8} />
            Updates
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            New versions come from this project&apos;s GitHub Releases. Your data folder is never touched.
          </p>
        </div>
        <Badge tone={tone}>
          {update?.state === 'available'
            ? `v${update.latest} available`
            : update?.state === 'up-to-date'
              ? 'Up to date'
              : update?.state === 'error'
                ? 'Check failed'
                : (update?.state ?? '…')}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Installed</dt>
            <dd className="font-medium">{status ? `v${status.version}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Latest</dt>
            <dd className="font-medium">{update?.latest ? `v${update.latest}` : '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Data folder</dt>
            <dd className="truncate font-mono text-[11px]" title={status?.dataDir}>
              {status?.dataDir ?? '—'}
            </dd>
          </div>
        </dl>

        {update?.message ? <p className="text-xs text-muted-foreground">{update.message}</p> : null}
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void act('check-update')}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check for updates
          </Button>
          {update?.state === 'available' ? (
            <Button variant="primary" disabled={busy || !status?.canSelfUpdate} onClick={() => void act('install-update')}>
              <CheckCircle2 className="h-4 w-4" /> Install v{update.latest} &amp; restart
            </Button>
          ) : null}
          {update?.notesUrl ? (
            <a className="inline-flex h-9 items-center text-xs text-primary underline" href={update.notesUrl} target="_blank" rel="noreferrer">
              Release notes
            </a>
          ) : null}
        </div>
        {status && !status.canSelfUpdate ? (
          <p className="text-[11px] text-muted-foreground">
            In-place updates need the Windows app in a writable folder. Download the new release manually instead.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
