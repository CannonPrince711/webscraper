import 'server-only';
import { errors } from '@webscraper/shared';
import { join } from 'node:path';

/**
 * Bridge to the desktop launcher (Webscraper.exe).
 *
 * The launcher owns things a web server cannot do for itself: restarting the
 * process and swapping the program files for an update. It exposes a small
 * control API on loopback; this module is the only caller, so the control token
 * stays on the server and never reaches a browser.
 *
 * Every route that mutates local state first calls `assertLocalRequest`. The
 * server only listens on 127.0.0.1, but a web page you visit can still make
 * your browser send requests to it (CSRF) or point a hostile DNS name at it
 * (rebinding). The Host and Origin checks close both.
 */

export const isDesktop = process.env.WEBSCRAPER_DESKTOP === '1';

export function envFilePath(): string | null {
  const home = process.env.WEBSCRAPER_HOME;
  return isDesktop && home ? join(home, '.env') : null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(hostHeader: string): string {
  return hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]!;
}

export function assertLocalRequest(request: Request): void {
  if (!isDesktop) throw errors.forbidden('This is only available in the desktop app.');

  const host = request.headers.get('host') ?? '';
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) {
    throw errors.forbidden('Requests must use the local address.');
  }

  const origin = request.headers.get('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* fall through to rejection */
    }
    if (originHost !== host) throw errors.forbidden('Cross-origin requests are not allowed.');
  }

  if (request.method !== 'GET' && !(request.headers.get('content-type') ?? '').includes('application/json')) {
    throw errors.forbidden('Expected a JSON request.');
  }
}

export interface DesktopStatus {
  version: string;
  dataDir: string;
  portable: boolean;
  canSelfUpdate: boolean;
  update: {
    state: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error' | 'up-to-date';
    latest: string | null;
    notesUrl: string | null;
    message: string | null;
    checkedAt: string | null;
  };
}

async function control<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
  const base = process.env.DESKTOP_CONTROL_URL;
  const token = process.env.DESKTOP_CONTROL_TOKEN;
  if (!base || !token) throw errors.internal('desktop control channel is not configured');

  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-control-token': token },
    signal: AbortSignal.timeout(method === 'GET' ? 5_000 : 30_000),
    cache: 'no-store',
  });
  if (!response.ok) throw errors.internal(`desktop control ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

export const desktop = {
  status: () => control<DesktopStatus>('/status', 'GET'),
  checkForUpdate: () => control<DesktopStatus>('/update/check', 'POST'),
  installUpdate: () => control<DesktopStatus>('/update/install', 'POST'),
  restart: () => control<{ ok: true }>('/restart', 'POST'),
  shutdown: () => control<{ ok: true }>('/shutdown', 'POST'),
};
