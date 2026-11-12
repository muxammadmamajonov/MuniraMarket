/**
 * Local Asia/Tashkent calendar arithmetic as pure functions. Instants are epoch seconds (the app
 * clock); times of day are `HH:MM[:SS[.ffffff]]` local wall-clock time.
 */

/** Asia/Tashkent is UTC+05:00 all year (no daylight saving since 1992). */
export const TASHKENT_OFFSET_SECONDS = 5 * 60 * 60;

/** `HH:MM[:SS[.ffffff]]` -> seconds since midnight (fraction kept). */
export function parseTimeOfDay(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(value);
  if (!match) throw new RangeError('time of day must look like HH:MM[:SS[.ffffff]]');
  const [, hours, minutes, seconds = '0', fraction = ''] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0${fraction}`);
}

/** The local (Asia/Tashkent) calendar date of an instant, as `YYYY-MM-DD`. */
export function tashkentDate(epochSeconds: number): string {
  const local = new Date(Math.floor((epochSeconds + TASHKENT_OFFSET_SECONDS) * 1000));
  return local.toISOString().slice(0, 10);
}

/** The instant (epoch seconds) of local wall-clock time `at` (`HH:MM[:SS]`) on `day`. */
export function tashkentInstant(day: string, at: string): number {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`) / 1000;
  return midnightUtc + parseTimeOfDay(at) - TASHKENT_OFFSET_SECONDS;
}
