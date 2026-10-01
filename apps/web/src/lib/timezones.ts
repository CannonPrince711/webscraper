/**
 * A deliberately short list of time zones for the schedule picker.
 *
 * `Intl.supportedValuesOf('timeZone')` returns ~400 entries; a `<select>` that
 * long is a usability problem, and 99% of users want one of these. Anything
 * else can be typed, and is validated by `assertValidTimeZone`.
 */
export const TIME_ZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'US Eastern' },
  { value: 'America/Chicago', label: 'US Central' },
  { value: 'America/Denver', label: 'US Mountain' },
  { value: 'America/Los_Angeles', label: 'US Pacific' },
  { value: 'America/Sao_Paulo', label: 'São Paulo' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Dublin', label: 'Dublin' },
  { value: 'Europe/Paris', label: 'Paris / Berlin / Madrid' },
  { value: 'Europe/Warsaw', label: 'Warsaw' },
  { value: 'Europe/Moscow', label: 'Moscow' },
  { value: 'Africa/Lagos', label: 'Lagos' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Karachi', label: 'Karachi' },
  { value: 'Asia/Kolkata', label: 'India' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Shanghai', label: 'China' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Australia/Perth', label: 'Perth' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

export const SUPPORTED_TIME_ZONE_HINT = 'IANA zone name, e.g. Europe/Berlin';
