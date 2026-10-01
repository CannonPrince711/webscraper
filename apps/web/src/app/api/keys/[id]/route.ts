import { errors } from '@webscraper/shared';
import { jsonOk, route } from '@/lib/api';
import { getStore } from '@/lib/store';

/**
 * Revoke a key.
 *
 * Deletion is a **soft** delete: `revoked_at` is set, the row stays. A hard
 * delete would erase the audit trail of which key made which request, which is
 * the first thing you want after a leak. Revocation takes effect immediately
 * because verification loads the row and checks `revoked_at` on every request.
 */
export const DELETE = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  if (orgContext.role === 'viewer' || orgContext.role === 'member') {
    throw errors.forbidden('Only owners and admins can revoke API keys.');
  }

  const keys = await store.listApiKeys();
  const key = keys.find((candidate) => candidate.id === id);
  if (!key) throw errors.notFound('API key');
  if (key.revoked_at) return jsonOk({ revoked: false, alreadyRevoked: true, key });

  await store.revokeApiKey(id);
  return jsonOk({ revoked: true, id });
});
