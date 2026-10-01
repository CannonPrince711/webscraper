'use client';

import { useState } from 'react';
import { Loader2, Power } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Stops the whole desktop app: running jobs are marked interrupted, then the
 * dashboard and the scraping engine exit. Closing the browser tab does not do
 * this — the app keeps running in its console window until it is stopped.
 */
export function StopButton() {
  const [state, setState] = useState<'idle' | 'stopping' | 'stopped'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    if (!window.confirm('Stop Webscraper? Any running jobs will be interrupted and the app will exit.')) return;
    setState('stopping');
    setError(null);
    try {
      const response = await fetch('/api/desktop/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'shutdown' }),
      });
      if (!response.ok) throw new Error(`Stop failed (${response.status})`);
      setState('stopped');
    } catch (caught) {
      setState('idle');
      setError(caught instanceof Error ? caught.message : 'Could not stop the app.');
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="danger"
        onClick={() => void stop()}
        disabled={state !== 'idle'}
        title={error ?? 'Stop everything and exit'}
        aria-label="Stop Webscraper"
      >
        {state === 'stopping' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">Stop</span>
      </Button>

      {state === 'stopped' ? (
        <div role="alertdialog" aria-live="assertive" className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6 text-center">
          <div className="max-w-sm space-y-2">
            <Power className="mx-auto h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
            <h1 className="text-lg font-semibold">Webscraper has stopped</h1>
            <p className="text-sm text-muted-foreground">
              The dashboard and scraping engine have exited. You can close this tab. Start Webscraper.exe again to continue.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
