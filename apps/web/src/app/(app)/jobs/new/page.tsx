import { JobWizard } from '@/components/job-wizard';
import { engineHealthOrNull } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New job' };

/**
 * The wizard reads two capabilities from the engine before it renders:
 *
 *  - **AI availability** decides whether the "describe it in English" box is
 *    shown. A hidden feature is better than a button that 503s.
 *  - **Decodo configuration** decides whether the residential-proxy option can
 *    be used *now*, or whether the job would fail at fetch time.
 */
export default async function NewJobPage() {
  const health = await engineHealthOrNull();
  const proxyChecks = (health?.checks?.proxy ?? {}) as Record<string, unknown>;

  return (
    <JobWizard
      aiAvailable={Boolean(health?.aiEnabled)}
      decodoConfigured={Boolean(proxyChecks.decodo_configured)}
    />
  );
}
