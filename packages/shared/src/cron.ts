/**
 * A small, dependency-free cron engine — shared by the web app and the worker.
 *
 * Both tiers must agree on when a schedule fires. If the web app computed
 * `next_run_at` one way and the worker recomputed it another, a job would
 * eventually run twice or not at all, and the bug would look random.
 *
 * Why hand-rolled instead of a package? Schedules are user input that decides
 * *when a scraper hits someone else's server*, so the semantics have to be
 * explicit and testable:
 *
 *  - Five fields only (minute hour day-of-month month day-of-week), which is the
 *    dialect users actually know; a six-field expression is rejected rather than
 *    silently misread.
 *  - **Day-of-month and day-of-week are OR-ed when both are restricted**, which
 *    is what Vixie cron does. Getting this wrong means a job that was supposed
 *    to run "on the 1st or on Mondays" quietly runs on the 1st only.
 *  - A bounded search: `nextRunAt` gives up after two years and returns `null`
 *    instead of hanging a request on an impossible expression such as
 *    `0 0 31 2 *` (31 February never exists).
 *  - Time zones are real IANA zones, resolved through `Intl`, not a fixed UTC
 *    offset — a daily 09:00 job must stay at 09:00 across a DST change.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SEARCH_DAYS = 732; // two years: enough to reject "31 February" style crons

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

interface Field {
  any: boolean;
  values: Set<number>;
}

export interface CronFields {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

const RANGES: Array<[keyof CronFields, number, number]> = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dayOfMonth', 1, 31],
  ['month', 1, 12],
  ['dayOfWeek', 0, 7], // 7 is accepted as Sunday
];

function parseField(raw: string, min: number, max: number, names?: readonly string[]): Field {
  const values = new Set<number>();
  let any = false;

  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new CronError(`empty value in "${raw}"`);

    const slash = token.indexOf('/');
    const rangePart = slash === -1 ? token : token.slice(0, slash);
    const stepPart = slash === -1 ? undefined : token.slice(slash + 1);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1 || step > max) {
      throw new CronError(`invalid step in "${token}"`);
    }

    let start: number;
    let end: number;

    if (rangePart === '*' || rangePart === '?') {
      start = min;
      end = max;
      if (step === 1 && stepPart === undefined) any = true;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      const a = bounds[0];
      const b = bounds[1];
      if (a === undefined || b === undefined) throw new CronError(`invalid range "${token}"`);
      start = resolveName(a, names, min);
      end = resolveName(b, names, min);
      if (start > end) throw new CronError(`reversed range "${token}"`);
    } else {
      start = resolveName(rangePart, names, min);
      // "5/10" means starting at 5, stepping 10 — not a single value.
      end = stepPart === undefined ? start : max;
    }

    if (start < min || end > max) throw new CronError(`out of range in "${token}" (${min}-${max})`);
    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) throw new CronError('no values matched');
  return { any, values };
}

function resolveName(token: string, names: readonly string[] | undefined, min: number): number {
  const value = Number(token);
  if (Number.isInteger(value)) return value;
  if (names) {
    const index = names.indexOf(token.trim().toUpperCase() as never);
    if (index >= 0) return index + (min === 0 && names === MONTHS ? 1 : 0);
  }
  throw new CronError(`"${token}" is not a number`);
}

/** Parse and validate a five-field expression. Throws `CronError`. */
export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError('A schedule needs exactly five fields: minute hour day-of-month month day-of-week.');
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const parsed: CronFields = {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    // Month names are 1-indexed, so a name resolves to index + 1.
    month: parseField(month, 1, 12, MONTHS),
    dayOfWeek: parseField(dayOfWeek, 0, 7, DAYS),
  };
  if (parsed.dayOfWeek.values.has(7)) {
    parsed.dayOfWeek.values.delete(7);
    parsed.dayOfWeek.values.add(0);
  }
  return parsed;
}

/** Convenience predicate for form validation. */
export function isValidCron(expression: string | null | undefined): boolean {
  if (!expression) return false;
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) lookup[part.type] = part.value;
  const hour = Number(lookup.hour) % 24; // "24" shows up at midnight in some ICU builds
  const weekday = DAYS.indexOf((lookup.weekday ?? 'Sun').toUpperCase() as never);
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

/** The zone's UTC offset (ms) at a given instant, DST aware. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Build a UTC instant from wall-clock parts in `timeZone`. */
export function fromZoned(parts: Omit<ZonedParts, 'weekday' | 'second'> & { second?: number }, timeZone: string): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  // Two passes: the first guess can land on the wrong side of a DST boundary.
  let ts = asUtc - offsetMs(new Date(asUtc), timeZone);
  ts = asUtc - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Ordered list of IANA zones for a picker, with a sane fallback. */
export function supportedTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.('timeZone');
  return zones && zones.length > 0 ? zones : ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'];
}

export function assertValidTimeZone(timeZone: string): string {
  try {
    formatterFor(timeZone).format(new Date());
    return timeZone;
  } catch {
    throw new CronError(`"${timeZone}" is not a recognised IANA time zone.`);
  }
}

// ---------------------------------------------------------------------------
// Next-fire calculation
// ---------------------------------------------------------------------------

function matchesDay(fields: CronFields, parts: ZonedParts): boolean {
  const domMatches = fields.dayOfMonth.values.has(parts.day);
  const dowMatches = fields.dayOfWeek.values.has(parts.weekday);

  // Vixie cron semantics: when both are restricted, either may match.
  if (!fields.dayOfMonth.any && !fields.dayOfWeek.any) return domMatches && dowMatches;
  if (!fields.dayOfMonth.any) return domMatches;
  if (!fields.dayOfWeek.any) return dowMatches;
  return domMatches || dowMatches;
}

/**
 * The next instant this expression fires, at or after `from`.
 *
 * The search steps in *local* time: whole days are skipped when the date does
 * not match, whole hours when the hour does not, which keeps a two-year search
 * to a few thousand cheap iterations instead of half a million.
 */
export function nextRunAt(expression: string, from: Date = new Date(), timeZone = 'UTC'): Date | null {
  const fields = parseCron(expression);
  assertValidTimeZone(timeZone);

  // Round up to the next whole minute: cron has minute resolution.
  let cursor = new Date(Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE);
  const limit = from.getTime() + SEARCH_DAYS * 24 * HOUR;

  while (cursor.getTime() <= limit) {
    const p = zonedParts(cursor, timeZone);

    if (!fields.month.values.has(p.month)) {
      cursor = fromZoned({ year: p.month === 12 ? p.year + 1 : p.year, month: p.month === 12 ? 1 : p.month + 1, day: 1, hour: 0, minute: 0 }, timeZone);
      continue;
    }
    if (!matchesDay(fields, p)) {
      cursor = fromZoned({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, timeZone);
      cursor = new Date(cursor.getTime() + 24 * HOUR);
      continue;
    }
    if (!fields.hour.values.has(p.hour)) {
      cursor = fromZoned({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: 0 }, timeZone);
      cursor = new Date(cursor.getTime() + HOUR);
      continue;
    }
    if (!fields.minute.values.has(p.minute)) {
      cursor = fromZoned({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute }, timeZone);
      cursor = new Date(cursor.getTime() + MINUTE);
      continue;
    }

    return cursor;
  }

  // Not reachable within the search horizon (e.g. "0 0 30 2 *").
  return null;
}

/** Human summary for the schedule picker. Deliberately conservative. */
export function describeCron(expression: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return 'Invalid schedule';
  }

  const minutes = [...fields.minute.values].sort((a, b) => a - b);
  const hours = [...fields.hour.values].sort((a, b) => a - b);
  const pad = (value: number) => String(value).padStart(2, '0');

  if (fields.minute.any && fields.hour.any) return 'Every minute';
  if (fields.minute.any) return hours.length === 1 ? `Every minute during the ${pad(hours[0]!)}:00 hour` : 'Every minute during selected hours';

  const times = hours.length <= 3 ? hours.map((hour) => minutes.map((minute) => `${pad(hour)}:${pad(minute)}`).join(', ')).join(', ') : null;

  if (!fields.dayOfMonth.any && !fields.dayOfWeek.any && !fields.month.any) {
    return times ? `Every day at ${times}` : 'Several times a day';
  }
  if (!fields.month.any && fields.dayOfMonth.any && fields.dayOfWeek.any) {
    const days = [...fields.dayOfMonth.values].sort((a, b) => a - b);
    const when = days.length <= 3 ? days.map((day) => `day ${day}`).join(', ') : `${days.length} days a month`;
    return times ? `On ${when} at ${times}` : `On ${when}`;
  }
  if (fields.month.any && fields.dayOfMonth.any && !fields.dayOfWeek.any) {
    const weekdays = [...fields.dayOfWeek.values].sort((a, b) => a - b).map((day) => DAYS[day]![0]! + DAYS[day]!.slice(1).toLowerCase());
    const when = weekdays.join(', ');
    return times ? `Every ${when} at ${times}` : `Every ${when}`;
  }
  if (fields.dayOfMonth.any && fields.dayOfWeek.any && fields.month.any) {
    const months = [...fields.month.values].sort((a, b) => a - b).map((month) => MONTHS[month - 1]![0]! + MONTHS[month - 1]!.slice(1).toLowerCase());
    return times ? `In ${months.join(', ')} at ${times}` : `In ${months.join(', ')}`;
  }
  return times ? `At ${times}` : 'Custom schedule';
}

/** Presets the schedule picker offers, in increasing order of annoyance. */
export const SCHEDULE_PRESETS: Array<{ label: string; cron: string | null }> = [
  { label: 'Manual only', cron: null },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 06:00', cron: '0 6 * * *' },
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { label: 'Weekly (Mon 07:00)', cron: '0 7 * * 1' },
  { label: 'Monthly (1st, 03:00)', cron: '0 3 1 * *' },
];
