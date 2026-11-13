'use client';

import { Button } from '@muniramarket/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BottomSheet } from '../bottom-sheet';
import { FOCUS_RING } from '../ui-classes';

/** Row height of a wheel in px; five rows are visible, the middle one is the value. */
export const WHEEL_ROW = 40;
const VISIBLE_ROWS = 5;
/** Quiet time after the last scroll event before the wheel commits its value. */
const SCROLL_SETTLE_MS = 120;

export interface WheelOption {
  value: number;
  text: string;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface IsoParts {
  year: number;
  month: number;
  day: number;
}

function partsOf(iso: string): IsoParts {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return { year: y, month: m, day: d };
}

function isoOf({ year, month, day }: IsoParts): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Keeps a picked date valid: day within the month, and the whole date within `min..max`. */
export function clampDate(parts: IsoParts, min: string, max: string): string {
  const day = Math.min(parts.day, daysInMonth(parts.year, parts.month));
  const iso = isoOf({ ...parts, day });
  if (iso < min) return min;
  if (iso > max) return max;
  return iso;
}

/**
 * One wheel: a scroll-snapping column (native momentum on touch), a `listbox` for assistive
 * technology, and arrow keys / Home / End / Page keys when focused. The value is committed when
 * scrolling settles, so the wheel never fights an in-flight fling.
 */
function Wheel({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: WheelOption[];
  value: number;
  onChange: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolling = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const baseId = useId();
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  // Bring the wheel to the value: instantly on open, smoothly after a keyboard / tap change or a
  // clamp (never mid-scroll). Scroll events caused by this are not read back as a choice.
  const placed = useRef(false);
  const programmatic = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || scrolling.current) return;
    const target = index * WHEEL_ROW;
    if (Math.abs(element.scrollTop - target) <= 1) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!placed.current || reduce || typeof element.scrollTo !== 'function') {
      element.scrollTop = target;
    } else {
      programmatic.current = true;
      element.scrollTo({ top: target, behavior: 'smooth' });
    }
    placed.current = true;
  }, [index, options.length]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const onScroll = () => {
    if (!programmatic.current) scrolling.current = true;
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      scrolling.current = false;
      if (programmatic.current) {
        programmatic.current = false;
        return;
      }
      const element = ref.current;
      if (element === null) return;
      const next = options[Math.round(element.scrollTop / WHEEL_ROW)];
      if (next !== undefined && next.value !== value) onChange(next.value);
    }, SCROLL_SETTLE_MS);
  };

  const step = (delta: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) onChange(next.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      PageUp: -5,
      PageDown: 5,
      Home: -options.length,
      End: options.length,
    };
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    step(delta);
  };

  const pad = ((VISIBLE_ROWS - 1) / 2) * WHEEL_ROW;

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={ref}
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={`${baseId}-${String(index)}`}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        style={{ height: WHEEL_ROW * VISIBLE_ROWS, paddingBlock: pad, scrollPaddingBlock: pad }}
        className={`snap-y snap-mandatory overflow-y-auto overscroll-contain rounded-xl [scrollbar-width:none] [mask-image:linear-gradient(to_bottom,transparent,black_35%,black_65%,transparent)] [&::-webkit-scrollbar]:hidden ${FOCUS_RING}`}
      >
        {options.map((option, position) => {
          const selected = position === index;
          return (
            <div
              key={option.value}
              id={`${baseId}-${String(position)}`}
              role="option"
              aria-selected={selected}
              onClick={() => onChange(option.value)}
              style={{ height: WHEEL_ROW }}
              className={`flex snap-center items-center justify-center text-[20px] tabular-nums select-none ${selected ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
            >
              {option.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface DateWheelSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** ISO date to start from (already within min..max). */
  initial: string;
  min: string;
  max: string;
  months: readonly string[];
  labels: { day: string; month: string; year: string; done: string; close: string };
  onDone: (iso: string) => void;
}

/**
 * The iOS-style date wheel in a bottom sheet: day, month and year columns that scroll and snap,
 * with the chosen row in a highlighted band. Dates outside `min..max` (for a birthday: before
 * 1900 or in the future) are clamped as soon as they are reached, so "Done" always returns a
 * valid date.
 */
export function DateWheelSheet({
  open,
  onClose,
  title,
  initial,
  min,
  max,
  months,
  labels,
  onDone,
}: DateWheelSheetProps) {
  const [iso, setIso] = useState(initial);
  const [seed, setSeed] = useState(initial);
  if (open && seed !== initial) {
    // Re-opened for another starting value: start from it.
    setSeed(initial);
    setIso(initial);
  }
  const parts = partsOf(iso);
  const minYear = partsOf(min).year;
  const maxYear = partsOf(max).year;

  const update = (patch: Partial<IsoParts>) => setIso(clampDate({ ...parts, ...patch }, min, max));

  const dayOptions = Array.from({ length: daysInMonth(parts.year, parts.month) }, (_, i) => ({
    value: i + 1,
    text: String(i + 1),
  }));
  const monthOptions = months.map((text, i) => ({ value: i + 1, text }));
  const yearOptions = Array.from({ length: maxYear - minYear + 1 }, (_, i) => ({
    value: minYear + i,
    text: String(minYear + i),
  }));

  return (
    <BottomSheet open={open} onClose={onClose} title={title} closeLabel={labels.close}>
      <div className="flex flex-col gap-4" data-testid="date-wheel">
        <div className="relative flex gap-1">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-1/2 h-10 -translate-y-1/2 rounded-xl bg-surface-muted"
          />
          <div className="relative flex w-full gap-1">
            <div className="w-[22%]">
              <Wheel
                label={labels.day}
                options={dayOptions}
                value={parts.day}
                onChange={(day) => update({ day })}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Wheel
                label={labels.month}
                options={monthOptions}
                value={parts.month}
                onChange={(month) => update({ month })}
              />
            </div>
            <div className="w-[28%]">
              <Wheel
                label={labels.year}
                options={yearOptions}
                value={parts.year}
                onChange={(year) => update({ year })}
              />
            </div>
          </div>
        </div>
        <Button
          size="lg"
          onClick={() => onDone(iso)}
          data-testid="date-wheel-done"
          className="w-full rounded-2xl"
        >
          {labels.done}
        </Button>
      </div>
    </BottomSheet>
  );
}
