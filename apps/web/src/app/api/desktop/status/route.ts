import { jsonOk, route } from '@/lib/api';
import { assertLocalRequest, desktop } from '@/lib/desktop';

export const GET = route(async (request) => {
  assertLocalRequest(request);
  return jsonOk(await desktop.status());
});
