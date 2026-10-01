/**
 * Proxy vocabulary — the contract between the wizard and the engine.
 *
 * The round-trip tests matter most: a value built by the wizard must parse back
 * into the same selection, or editing a saved job silently changes its behaviour.
 */

import { describe, expect, it } from 'vitest';
import {
  DECODO_PROXY_VALUE,
  buildProxyValue,
  describeProxy,
  newProxySessionId,
  parseProxyValue,
  usesDecodo,
} from '../src/proxy';

describe('buildProxyValue', () => {
  it('stores null for a direct connection', () => {
    expect(buildProxyValue({ kind: 'direct' })).toBeNull();
  });

  it('stores the bare literal when Decodo is used without targeting', () => {
    expect(buildProxyValue({ kind: 'decodo' })).toBe(DECODO_PROXY_VALUE);
  });

  it('encodes country, city, session and sticky lifetime', () => {
    const value = buildProxyValue({
      kind: 'decodo',
      country: 'US',
      city: 'New York',
      session: 'abc123',
      stickyMinutes: 10,
    });
    expect(value).toBe('decodo://?country=us&city=new_york&session=abc123&sticky=10');
  });

  it('clamps the sticky lifetime to the provider maximum', () => {
    expect(buildProxyValue({ kind: 'decodo', country: 'us', stickyMinutes: 99999 })).toContain('sticky=1440');
    expect(buildProxyValue({ kind: 'decodo', country: 'us', stickyMinutes: 0.2 })).toContain('sticky=1');
  });

  it('treats an empty custom URL as a direct connection', () => {
    expect(buildProxyValue({ kind: 'custom', customUrl: '   ' })).toBeNull();
    expect(buildProxyValue({ kind: 'custom', customUrl: ' http://p:3128 ' })).toBe('http://p:3128');
  });
});

describe('parseProxyValue', () => {
  it.each([null, undefined, ''])('treats %s as direct', (value) => {
    expect(parseProxyValue(value)).toEqual({ kind: 'direct' });
  });

  it('round-trips a targeted Decodo value', () => {
    const selection = {
      kind: 'decodo' as const,
      country: 'de',
      city: 'berlin',
      session: 'sess1',
      stickyMinutes: 30,
    };
    expect(parseProxyValue(buildProxyValue(selection))).toEqual(selection);
  });

  it('parses the bare literal', () => {
    expect(parseProxyValue('decodo')).toEqual({ kind: 'decodo' });
  });

  it('keeps custom URLs intact', () => {
    expect(parseProxyValue('socks5://proxy.internal:1080')).toEqual({
      kind: 'custom',
      customUrl: 'socks5://proxy.internal:1080',
    });
  });
});

describe('describeProxy', () => {
  it('labels a direct connection', () => {
    expect(describeProxy(null)).toMatchObject({ kind: 'direct', label: 'Direct', carriesCredentials: false });
  });

  it('names the country and city', () => {
    const description = describeProxy('decodo://?country=us&city=new_york&session=x&sticky=10');
    expect(description.label).toBe('Decodo · United States · New York');
    expect(description.detail).toContain('sticky IP for 10 min');
    expect(description.carriesCredentials).toBe(false);
  });

  it('says rotating when no session is pinned', () => {
    expect(describeProxy('decodo://?country=jp').detail).toContain('rotating IP');
  });

  it('never exposes credentials from a custom proxy URL', () => {
    const description = describeProxy('http://bob:hunter2@proxy.internal:3128');
    expect(description.carriesCredentials).toBe(true);
    expect(JSON.stringify(description)).not.toContain('hunter2');
    expect(description.detail).toContain('proxy.internal:3128');
  });

  it('survives a malformed custom URL', () => {
    expect(describeProxy('http://%%%').detail).toContain('a proxy');
  });
});

describe('usesDecodo', () => {
  it.each(['decodo', 'decodo://?country=us', 'DECODO'])('recognises %s', (value) => {
    expect(usesDecodo(value)).toBe(true);
  });

  it.each([null, '', 'http://proxy.internal:3128'])('rejects %s', (value) => {
    expect(usesDecodo(value)).toBe(false);
  });
});

describe('newProxySessionId', () => {
  it('produces a unique, URL-safe id', () => {
    const first = newProxySessionId();
    const second = newProxySessionId();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^ws[a-z0-9]{6,}$/);
    expect(encodeURIComponent(first)).toBe(first);
  });
});
