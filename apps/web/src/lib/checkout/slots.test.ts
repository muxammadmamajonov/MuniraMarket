import { describe, expect, it } from 'vitest';
import { slotOption } from './test-fixtures';
import {
  addDays,
  bookableSlot,
  clockTime,
  dayAvailability,
  dayKind,
  dayLabel,
  defaultDay,
  groupSlotsByDay,
  hasBookableSlot,
  isSlotFull,
  revealOffset,
  shortDate,
  slotWindow,
  todayInTashkent,
  weekdayOf,
} from './slots';

const COPY = {
  today: 'Bugun',
  tomorrow: 'Ertaga',
  weekdays: ['Yak', 'Dush', 'Sesh', 'Chor', 'Pay', 'Jum', 'Shan'],
};

describe('todayInTashkent', () => {
  it('reads the date in Tashkent (UTC+5), not in the runtime zone', () => {
    expect(todayInTashkent(new Date('2026-10-31T18:59:00Z'))).toBe('2026-10-31');
    expect(todayInTashkent(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11-01');
  });
});

describe('date helpers', () => {
  it('moves dates across month and year ends without touching the runtime zone', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('garbage', 1)).toBe('garbage');
  });

  it('knows the weekday (0 = Sunday) and formats day-first', () => {
    expect(weekdayOf('2026-11-01')).toBe(0);
    expect(weekdayOf('2026-11-02')).toBe(1);
    expect(weekdayOf('nope')).toBeNull();
    expect(shortDate('2026-11-03')).toBe('03.11');
    expect(shortDate('nope')).toBe('nope');
  });

  it('writes a window with an en dash and drops seconds', () => {
    expect(slotWindow({ starts_at: '10:00', ends_at: '12:00' })).toBe('10:00–12:00');
    expect(slotWindow({ starts_at: '10:00:00', ends_at: '12:30:00' })).toBe('10:00–12:30');
    expect(clockTime('9')).toBe('9');
  });
});

describe('groupSlotsByDay', () => {
  it('groups by date, with days and times in order whatever order the API sent', () => {
    const days = groupSlotsByDay([
      slotOption({ id: 'c', date: '2026-11-02', starts_at: '09:00' }),
      slotOption({ id: 'b', date: '2026-10-31', starts_at: '14:00' }),
      slotOption({ id: 'a', date: '2026-10-31', starts_at: '10:00' }),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-10-31', '2026-11-02']);
    expect(days[0]?.slots.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns nothing for no slots', () => {
    expect(groupSlotsByDay([])).toEqual([]);
  });
});

describe('dayLabel', () => {
  it('says today and tomorrow in words, any other day by weekday, always with the date', () => {
    expect(dayKind('2026-10-31', '2026-10-31')).toBe('today');
    expect(dayLabel('2026-10-31', '2026-10-31', COPY)).toEqual({
      name: 'Bugun',
      date: '31.10',
      text: 'Bugun, 31.10',
    });
    expect(dayLabel('2026-11-01', '2026-10-31', COPY).name).toBe('Ertaga');
    expect(dayLabel('2026-11-03', '2026-10-31', COPY)).toEqual({
      name: 'Sesh',
      date: '03.11',
      text: 'Sesh, 03.11',
    });
  });

  it('calls tomorrow "tomorrow" across a month boundary', () => {
    expect(dayLabel('2026-11-01', '2026-10-31', COPY).name).toBe('Ertaga');
    expect(dayLabel('2027-01-01', '2026-12-31', COPY).name).toBe('Ertaga');
  });
});

describe('availability', () => {
  it('treats a flagged slot, or one with no places, as full', () => {
    expect(isSlotFull(slotOption({ is_full: true, remaining: 3 }))).toBe(true);
    expect(isSlotFull(slotOption({ is_full: false, remaining: 0 }))).toBe(true);
    expect(isSlotFull(slotOption({ is_full: false, remaining: 1 }))).toBe(false);
  });

  it('finds a slot only while it can still be booked', () => {
    const slots = [slotOption({ id: 'open' }), slotOption({ id: 'full', is_full: true })];
    expect(bookableSlot(slots, 'open')?.id).toBe('open');
    expect(bookableSlot(slots, 'full')).toBeNull();
    expect(bookableSlot(slots, 'gone')).toBeNull();
    expect(bookableSlot(slots, null)).toBeNull();
    expect(hasBookableSlot(slots)).toBe(true);
    expect(hasBookableSlot([slotOption({ is_full: true })])).toBe(false);
    expect(hasBookableSlot([])).toBe(false);
  });
});

describe('dayAvailability and defaultDay', () => {
  const free = (id: string, date: string) => slotOption({ id, date });
  const full = (id: string, date: string) => slotOption({ id, date, is_full: true, remaining: 0 });
  const days = groupSlotsByDay([
    full('a', '2026-10-31'),
    full('b', '2026-10-31'),
    free('c', '2026-11-01'),
    full('d', '2026-11-01'),
    free('e', '2026-11-02'),
    free('f', '2026-11-02'),
  ]);

  it('counts windows that can still be booked, and flags a day with none', () => {
    expect(days.map(dayAvailability)).toEqual([
      { free: 0, full: true },
      { free: 1, full: false },
      { free: 2, full: false },
    ]);
  });

  it('treats a window with no places as full even when the server did not flag it', () => {
    const [day] = groupSlotsByDay([slotOption({ is_full: false, remaining: 0 })]);
    expect(day === undefined ? null : dayAvailability(day)).toEqual({ free: 0, full: true });
  });

  it('opens on the day of the chosen window', () => {
    expect(defaultDay(days, 'e')).toBe('2026-11-02');
    // A window that has just filled up: stay where the customer was.
    expect(defaultDay(days, 'a')).toBe('2026-10-31');
  });

  it('otherwise opens on the first day that can be booked, skipping full days', () => {
    expect(defaultDay(days, null)).toBe('2026-11-01');
    expect(defaultDay(days, 'gone')).toBe('2026-11-01');
  });

  it('opens on the first day when everything is full, and on nothing without days', () => {
    const allFull = groupSlotsByDay([full('x', '2026-11-05'), full('y', '2026-11-06')]);
    expect(defaultDay(allFull, null)).toBe('2026-11-05');
    expect(defaultDay([], null)).toBeNull();
  });
});

describe('revealOffset', () => {
  const base = { viewSize: 300, contentSize: 1000, padding: 16 };

  it('does not move when the item is already comfortably in view', () => {
    expect(revealOffset({ ...base, viewStart: 100, itemStart: 150, itemSize: 80 })).toBe(100);
  });

  it('scrolls back so an item hidden on the start side shows with its padding', () => {
    expect(revealOffset({ ...base, viewStart: 400, itemStart: 300, itemSize: 80 })).toBe(284);
  });

  it('scrolls forward so an item cut off at the end shows with its padding', () => {
    expect(revealOffset({ ...base, viewStart: 0, itemStart: 260, itemSize: 80 })).toBe(56);
  });

  it('never scrolls before 0 or past the content', () => {
    expect(revealOffset({ ...base, viewStart: 50, itemStart: 4, itemSize: 80 })).toBe(0);
    expect(revealOffset({ ...base, viewStart: 600, itemStart: 940, itemSize: 80 })).toBe(700);
  });

  it('does not move when the content fits the view', () => {
    const fits = { viewStart: 0, viewSize: 300, contentSize: 280, itemSize: 80, padding: 16 };
    expect(revealOffset({ ...fits, itemStart: 200 })).toBe(0);
  });
});
