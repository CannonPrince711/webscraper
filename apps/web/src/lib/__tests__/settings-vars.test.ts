import { describe, expect, it } from 'vitest';
import { applyEnvUpdates, findVar, parseEnvText, SETTING_VARS, validateValue } from '../settings-vars';

describe('settings variables', () => {
  it('never exposes the app or engine secrets for editing', () => {
    const keys = SETTING_VARS.map((item) => item.key);
    expect(keys).not.toContain('APP_SECRET');
    expect(keys).not.toContain('ENGINE_API_KEY');
    expect(keys).not.toContain('ENGINE_URL');
  });

  it('marks credentials as secret', () => {
    for (const key of ['AI_API_KEY', 'DECODO_PASSWORD', 'ENGINE_PROXY_URLS']) {
      expect(findVar(key)?.secret).toBe(true);
    }
  });

  it('validates by kind', () => {
    expect(validateValue(findVar('ENGINE_MAX_CONCURRENCY')!, '8')).toBeNull();
    expect(validateValue(findVar('ENGINE_MAX_CONCURRENCY')!, '0')).toMatch(/at least/);
    expect(validateValue(findVar('ENGINE_MAX_CONCURRENCY')!, 'x')).toMatch(/whole number/);
    expect(validateValue(findVar('ENGINE_ENABLE_BROWSER')!, 'yes')).toMatch(/true or false/);
    expect(validateValue(findVar('AI_BASE_URL')!, 'ftp://x')).toMatch(/http/);
    expect(validateValue(findVar('AI_BASE_URL')!, 'https://api.example.com/v1')).toBeNull();
    expect(validateValue(findVar('AI_MODEL')!, 'a\nB=1')).toMatch(/line breaks/);
    expect(validateValue(findVar('AI_MODEL')!, '')).toBeNull();
  });

  it('round-trips values, preserving comments and unmanaged keys', () => {
    const before = '# my notes\nAPP_THING=keep\nAI_MODEL=old\n';
    const after = applyEnvUpdates(before, { AI_MODEL: 'gpt-4o', AI_API_KEY: 'sk test#1', DECODO_COUNTRY: null });
    expect(after).toContain('# my notes');
    expect(after).toContain('APP_THING=keep');
    expect(after).toContain('AI_MODEL=gpt-4o');
    expect(parseEnvText(after)).toMatchObject({ AI_MODEL: 'gpt-4o', AI_API_KEY: 'sk test#1' });
  });

  it('removes a key when cleared', () => {
    const after = applyEnvUpdates('AI_MODEL=x\nDECODO_COUNTRY=us\n', { DECODO_COUNTRY: null });
    expect(parseEnvText(after)).toEqual({ AI_MODEL: 'x' });
  });
});
