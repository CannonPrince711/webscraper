import { cn } from '@webscraper/shared';
import { Cpu } from 'lucide-react';
import { engineHealthOrNull } from '@/lib/engine';

/**
 * Engine health, rendered inside a Suspense boundary.
 *
 * It probes a network service, so it must never be on the dashboard's critical
 * path: a 5-second connect timeout would otherwise delay the whole page. With
 * Suspense, the rest of the dashboard streams immediately and this card fills in.
 */
export async function EngineStatus() {
  const health = await engineHealthOrNull();

  if (!health) {
    return (
      <Shell tone="danger" title="Engine unreachable" detail="Jobs will queue but cannot run until it is back." />
    );
  }

  const degraded = !health.browserAvailable || !health.aiEnabled;

  return (
    <Shell
      tone={degraded ? 'warning' : 'success'}
      title={`Engine ${health.status} · v${health.version}`}
      detail={[
        health.browserAvailable ? 'browser rendering' : 'browser off',
        health.aiEnabled ? 'AI on' : 'AI off',
        `up ${Math.floor(health.uptimeSeconds / 60)}m`,
      ].join(' · ')}
    />
  );
}

function Shell({ tone, title, detail }: { tone: 'success' | 'warning' | 'danger'; title: string; detail: string }) {
  const dot =
    tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-danger';

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <Cpu className="mt-0.5 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-xs font-medium">
          <span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden />
          {title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
