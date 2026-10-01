import { errors } from '@webscraper/shared';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { fromZod, jsonOk, readJson, route } from '@/lib/api';
import { assertLocalRequest, envFilePath } from '@/lib/desktop';
import { applyEnvUpdates, findVar, parseEnvText, SETTING_VARS, validateValue } from '@/lib/settings-vars';

/**
 * Desktop settings variables.
 *
 * Reads and writes the whitelist in `lib/settings-vars.ts` against the
 * portable data folder's `.env`. Secret values are write-only: GET reports
 * whether one is set, never what it is.
 */

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export const GET = route(async (request) => {
  assertLocalRequest(request);
  const path = envFilePath();
  if (!path) throw errors.forbidden('Settings variables are only available in the desktop app.');

  const stored = parseEnvText(await readEnvFile(path));
  return jsonOk({
    variables: SETTING_VARS.map((item) => ({
      ...item,
      isSet: Boolean(stored[item.key]),
      value: item.secret ? null : (stored[item.key] ?? ''),
    })),
    restartRequired: false,
  });
});

const bodySchema = z.object({
  // A string sets or (when empty) clears the key; keys left out are untouched.
  values: z.record(z.string(), z.string()),
});

export const PUT = route(async (request) => {
  assertLocalRequest(request);
  const path = envFilePath();
  if (!path) throw errors.forbidden('Settings variables are only available in the desktop app.');

  const parsed = bodySchema.safeParse(await readJson(request, 64_000));
  if (!parsed.success) throw fromZod(parsed.error);

  const updates: Record<string, string | null> = {};
  const problems: Array<{ field: string; message: string }> = [];
  for (const [key, raw] of Object.entries(parsed.data.values)) {
    const item = findVar(key);
    if (!item) {
      problems.push({ field: key, message: 'That variable cannot be changed here.' });
      continue;
    }
    const value = raw.trim();
    const problem = validateValue(item, value);
    if (problem) problems.push({ field: key, message: problem });
    else updates[key] = value === '' ? null : value;
  }
  if (problems.length > 0) {
    throw errors.invalidConfig(problems[0]!.message, { problems });
  }

  const next = applyEnvUpdates(await readEnvFile(path), updates);
  await mkdir(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated .env.
  const temp = `${path}.tmp`;
  await writeFile(temp, next, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);

  return jsonOk({ saved: Object.keys(updates), restartRequired: true });
});
