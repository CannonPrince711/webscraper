import { targetUrlSchema } from '@webscraper/shared';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { engine } from '@/lib/engine';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Pre-flight a list of targets so the wizard can show, per URL, whether it will
 * actually be fetchable: egress policy (SSRF), robots.txt, and whether a
 * sitemap exists.
 *
 * This is a UX endpoint, not a security boundary — the engine re-validates on
 * every fetch. Its value is telling a user *before* they save a job that
 * `192.168.1.1` is not a public address.
 */
const schema = z.object({
  urls: z.array(targetUrlSchema).min(1).max(25),
  includeRobots: z.boolean().default(true),
});

export const POST = route(async (request) => {
  const store = await getStore();
  const context = await store.getOrgContext();
  await enforceRateLimit(`targets:check:${context.org.id}`, { max: 60, windowMs: 60_000 });

  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) throw fromZod(parsed.error);

  const { urls, includeRobots } = parsed.data;

  const results: Array<{
    url: string;
    ok: boolean;
    reason?: string;
    code?: string;
    host?: string;
    robots?: { allowed: boolean; reason: string; crawlDelay?: number | null };
  }> = urls.map((url) => ({ url, ok: true }));

  try {
    const ssrf = await engine.checkTargets(urls);
    for (const [index, result] of ssrf.results.entries()) {
      if (!result.allowed) {
        results[index] = { url: result.url, ok: false, reason: result.reason, code: result.code, host: result.host };
      } else {
        results[index] = { ...results[index]!, host: result.host };
      }
    }
  } catch {
    // The engine being down must not block the wizard: report "unknown" by
    // leaving ok:true and letting the run surface the real outcome.
    return jsonOk({ results, engineAvailable: false });
  }

  if (includeRobots) {
    const allowedUrls = results.filter((result) => result.ok).map((result) => result.url);
    if (allowedUrls.length > 0) {
      try {
        const robots = await engine.checkRobots(allowedUrls);
        for (const decision of robots.results) {
          const entry = results.find((result) => result.url === decision.url);
          if (!entry) continue;
          entry.robots = { allowed: decision.allowed, reason: decision.reason, crawlDelay: decision.crawlDelay };
          if (!decision.allowed) {
            // A robots block is a warning rather than a failure: the user can
            // override it per job if they have the right to scrape the target.
            entry.ok = false;
            entry.code = 'robots_disallowed';
            entry.reason = 'Disallowed by robots.txt — you can override this if you have permission to scrape it.';
          }
        }
      } catch {
        // Robots check is best-effort.
      }
    }
  }

  return jsonOk({ results, engineAvailable: true });
});
