import { describe, expect, it } from 'vitest';
import { slotOption } from './test-fixtures';
import {
  addDays,
  bookableSlot,
  clockTime,
  dayKind,
  dayLabel,
  groupSlotsByDay,
  hasBookableSlot,
  isSlotFull,
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
