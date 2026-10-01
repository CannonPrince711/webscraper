import { errors } from '@webscraper/shared';
import { route } from '@/lib/api';
import { enforceRateLimit } from '@/lib/rate-limit';
import { getStore } from '@/lib/store';

/**
 * Live run progress over Server-Sent Events.
 *
 * Why SSE rather than WebSockets, and why this is not the only mechanism:
 *
 *  - SSE is a plain HTTP response. It works through the same proxies, auth and
 *    logging as every other route, needs no upgrade handshake, and reconnects
 *    automatically in the browser.
 *  - With Supabase configured, the client *additionally* subscribes to
 *    Realtime on `job_runs` and gets sub-second updates; SSE is the fallback
 *    that also works in demo mode, where there is no Realtime server.
 *  - The stream is bounded (5 minutes) and closes itself on a terminal status.
 *    A progress endpoint that can live forever is a slow resource leak that
 *    only shows up under load.
 *
 * The poll interval is 1.2s — fast enough to feel live, slow enough that a
 * thousand watchers do not become a thousand queries per second.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const POLL_MS = 1_200;
const HEARTBEAT_MS = 20_000;
const MAX_STREAM_MS = 5 * 60_000;

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const GET = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const store = await getStore();
  const orgContext = await store.getOrgContext();

  // One connection per run per viewer is expected; dozens is not.
  await enforceRateLimit(`stream:${orgContext.org.id}`, { max: 120, windowMs: 60_000 });

  const initial = await store.getRun(id);
  if (!initial) throw errors.notFound('Run');

  const encoder = new TextEncoder();
  let closed = false;
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client went away between the check and the enqueue.
          closed = true;
        }
      };

      const abort = () => {
        closed = true;
      };
      request.signal.addEventListener('abort', abort, { once: true });

      // `retry` tells the browser how quickly to reconnect if the stream drops.
      send('hello', {
        runId: initial.id,
        runNumber: initial.run_number,
        status: initial.status,
        pollMs: POLL_MS,
        progressMode: 'poll',
      });

      let signature = '';
      let lastBeat = Date.now();

      try {
        while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
          const run = await store.getRun(id);
          if (!run) {
            send('gone', { runId: id });
            break;
          }

          // A cheap change detector: only ship a payload when something moved.
          const nextSignature = [
            run.status,
            run.pages_total,
            run.pages_ok,
            run.pages_failed,
            run.records_count,
            run.log.length,
          ].join(':');

          if (nextSignature !== signature) {
            signature = nextSignature;
            send('snapshot', {
              run: {
                id: run.id,
                status: run.status,
                run_number: run.run_number,
                started_at: run.started_at,
                finished_at: run.finished_at,
                duration_ms: run.duration_ms,
                pages_total: run.pages_total,
                pages_ok: run.pages_ok,
                pages_failed: run.pages_failed,
                records_count: run.records_count,
                records_new: run.records_new,
                records_changed: run.records_changed,
                ai_tokens_used: run.ai_tokens_used,
                error_code: run.error_code,
                error_message: run.error_message,
                log: run.log.slice(-40),
              },
            });
          }

          if (TERMINAL.has(run.status)) {
            send('end', { status: run.status, durationMs: run.duration_ms });
            break;
          }

          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            lastBeat = Date.now();
            // A comment line keeps intermediaries from closing an idle stream.
            if (!closed) {
              try {
                controller.enqueue(encoder.encode(': keep-alive\n\n'));
              } catch {
                closed = true;
              }
            }
          }

          await sleep(POLL_MS);
        }

        if (!closed && Date.now() - startedAt >= MAX_STREAM_MS) {
          // Not an error: the client reconnects and picks up where it left off.
          send('timeout', { reconnectedAfterMs: 0 });
        }
      } catch {
        send('error', { code: 'stream_failed', message: 'Progress updates stopped. Refresh to see the latest state.' });
      } finally {
        request.signal.removeEventListener('abort', abort);
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, no-transform',
      connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which turns a live stream
      // into a 30-second batch. This header disables it; the value is ignored
      // by servers that do not care.
      'x-accel-buffering': 'no',
    },
  });
});
