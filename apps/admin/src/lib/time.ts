/** Asia/Tashkent is UTC+05:00 all year (no DST), so a fixed offset is exact. */
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Today's date in Tashkent as `YYYY-MM-DD`. */
export function todayInTashkent(now: Date = new Date()): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}
