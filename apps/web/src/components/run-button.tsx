'use client';

import { Play, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';

/**
 * "Run now".
 *
 * The API returns 202 with a run id — the run itself may take minutes, so the
 * button does not wait for it. It refreshes the route so the new run appears,
 * then gets out of the way. Errors are shown inline rather than as an alert:
 * "already running" and "target blocked" are both normal outcomes a user should
 * read, not dismiss.
 */
export function RunButton({
  jobId,
  size = 'sm',
  variant = 'primary',
  label = 'Run',
}: {
  jobId: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary';
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/jobs/${jobId}/run`, { method: 'POST' });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
        execution?: string;
      };

      if (!response.ok) {
        setError(payload.error?.message ?? 'The run could not be started.');
        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError('The request failed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button size={size} variant={variant} onClick={run} disabled={busy || pending}>
        {busy || pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        {label}
      </Button>
      {error ? (
        <span className="max-w-56 text-right text-[11px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
