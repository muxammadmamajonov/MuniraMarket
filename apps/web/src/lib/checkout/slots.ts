import type { DeliverySlotOption } from '@muniramarket/contracts';
import { DISPLAY_TIME_ZONE } from '@/i18n/date';

/**
 * Delivery-slot helpers: grouping the options a quote offers by day, and naming days. Dates are the
 * API's local Asia/Tashkent calendar dates (`YYYY-MM-DD`); "today" is read in the same zone so a
 * phone in another time zone still sees the shop's days.
 */

/** Fewer free places than this are called out on the option ("2 places left"). */
export const LOW_REMAINING_THRESHOLD = 3;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const todayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in Tashkent as `YYYY-MM-DD`. */
export function todayInTashkent(now: Date = new Date()): string {
  const part = Object.fromEntries(todayFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  return `${part['year']}-${part['month']}-${part['day']}`;
}

function parseDate(date: string): { year: number; month: number; day: number } | null {
  const match = DATE_PATTERN.exec(date);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** `date` moved by `days` calendar days (`YYYY-MM-DD`), independent of the runtime's zone. */
export function addDays(date: string, days: number): string {
  const parsed = parseDate(date);
  if (parsed === null) return date;
  const moved = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return moved.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday, or `null` for a malformed date. */
export function weekdayOf(date: string): number | null {
  const parsed = parseDate(date);
  if (parsed === null) return null;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

/** `2026-11-03` -> `03.11` (the app writes dates day-first). */
export function shortDate(date: string): string {
  const parsed = parseDate(date);
  if (parsed === null) return date;
  return `${String(parsed.day).padStart(2, '0')}.${String(parsed.month).padStart(2, '0')}`;
}

/** `HH:MM` from a time that may carry seconds (`10:00:00`). */
export function clockTime(time: string): string {
  return /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : time;
}

/** `10:00–12:00` with a real en dash. */
export function slotWindow(slot: { starts_at: string; ends_at: string }): string {
  return `${clockTime(slot.starts_at)}–${clockTime(slot.ends_at)}`;
}

export interface SlotDay {
  date: string;
  slots: DeliverySlotOption[];
}

/** Full slots offer no places even when the server forgot to flag them. */
export function isSlotFull(slot: Pick<DeliverySlotOption, 'is_full' | 'remaining'>): boolean {
  return slot.is_full || slot.remaining <= 0;
}

/** Options grouped by date, days and the times within a day in chronological order. */
export function groupSlotsByDay(slots: readonly DeliverySlotOption[]): SlotDay[] {
  const byDate = new Map<string, DeliverySlotOption[]>();
  for (const slot of slots) {
    const day = byDate.get(slot.date);
    if (day === undefined) byDate.set(slot.date, [slot]);
    else day.push(slot);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, daySlots]) => ({
      date,
      slots: [...daySlots].sort((a, b) =>
        a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0,
      ),
    }));
}

export type DayKind = 'today' | 'tomorrow' | 'other';

export function dayKind(date: string, today: string): DayKind {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return 'other';
}

/** The slot with this id, when it can still be booked. */
export function bookableSlot(
  slots: readonly DeliverySlotOption[],
  id: string | null,
): DeliverySlotOption | null {
  if (id === null) return null;
  const slot = slots.find((candidate) => candidate.id === id);
  return slot === undefined || isSlotFull(slot) ? null : slot;
}

/** True when at least one option can still be booked. */
export function hasBookableSlot(slots: readonly DeliverySlotOption[]): boolean {
  return slots.some((slot) => !isSlotFull(slot));
}

export interface DayLabel {
  /** "Today", "Tomorrow" or the weekday. */
  name: string;
  /** `03.11`. */
  date: string;
  /** `Today, 31.10`: for places that have one line (screen readers, the order summary). */
  text: string;
}

/** Names a day for the picker: today / tomorrow by word, anything else by weekday, always dated. */
export function dayLabel(
  date: string,
  today: string,
  copy: { today: string; tomorrow: string; weekdays: readonly string[] },
): DayLabel {
  const kind = dayKind(date, today);
  const weekday = weekdayOf(date);
  const name =
    kind === 'today'
      ? copy.today
      : kind === 'tomorrow'
        ? copy.tomorrow
        : ((weekday === null ? undefined : copy.weekdays[weekday]) ?? date);
  const short = shortDate(date);
  return { name, date: short, text: `${name}, ${short}` };
}

/** How much of a day can still be booked: windows with free places, and whether none are left. */
export function dayAvailability(day: SlotDay): { free: number; full: boolean } {
  const free = day.slots.filter((slot) => !isSlotFull(slot)).length;
  return { free, full: free === 0 };
}

/**
 * The day the picker opens on: the day of the chosen window (even if it has just filled up, so the
 * customer stays where they were), otherwise the first day with a window that can be booked,
 * otherwise the first day. `null` when there are no days at all.
 */
export function defaultDay(days: readonly SlotDay[], selectedId: string | null): string | null {
  if (days.length === 0) return null;
  if (selectedId !== null) {
    const holder = days.find((day) => day.slots.some((slot) => slot.id === selectedId));
    if (holder !== undefined) return holder.date;
  }
  const bookable = days.find((day) => !dayAvailability(day).full);
  return (bookable ?? days[0])?.date ?? null;
}

/**
 * Where a scroller starting at `viewStart` (size `viewSize`) must scroll so that the item at
 * `itemStart` (size `itemSize`) is fully visible with `padding` to spare on the side it came in
 * from. It does not move at all when the item is already comfortably in view, and never goes past
 * the content (`contentSize`) or before 0.
 */
export function revealOffset(args: {
  viewStart: number;
  viewSize: number;
  contentSize: number;
  itemStart: number;
  itemSize: number;
  padding: number;
}): number {
  const { viewStart, viewSize, contentSize, itemStart, itemSize, padding } = args;
  let next = viewStart;
  if (itemStart - padding < viewStart) next = itemStart - padding;
  else if (itemStart + itemSize + padding > viewStart + viewSize) {
    next = itemStart + itemSize + padding - viewSize;
  }
  return Math.max(0, Math.min(next, Math.max(0, contentSize - viewSize)));
}
