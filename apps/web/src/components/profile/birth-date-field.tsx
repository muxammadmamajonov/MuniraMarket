'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import {
  isoToDisplay,
  maskBirthDateInput,
  MIN_BIRTH_DATE,
  parseBirthDate,
  tashkentToday,
} from '@/lib/profile/birth-date';
import type { FieldControlProps } from '../form-field';
import { CalendarIcon } from '../icons';
import { DateWheelSheet } from '../ui/date-wheel-sheet';
import { FOCUS_RING, INPUT, PRESS } from '../ui-classes';

/** Where the wheel starts when the field is empty: a plausible adult birthday, not today. */
export const WHEEL_START = '2000-01-01';

export interface BirthDateFieldProps {
  control: FieldControlProps;
  /** `DD.MM.YYYY` as typed (possibly partial). */
  value: string;
  onChange: (display: string) => void;
  placeholder: string;
  disabled?: boolean;
}

/**
 * Birthday, two ways that stay in sync: type `DD.MM.YYYY` (digits only, the dots appear by
 * themselves, the numeric keypad opens on phones), or tap the calendar button for the iOS-style
 * date wheel. The wheel starts at the typed date when it is valid and is bounded to
 * 1900-01-01 .. today, so a future date cannot be picked.
 */
export function BirthDateField({
  control,
  value,
  onChange,
  placeholder,
  disabled = false,
}: BirthDateFieldProps) {
  const { dict } = useI18n();
  const t = dict.personal;
  const [open, setOpen] = useState(false);
  const today = tashkentToday();
  const parsed = parseBirthDate(value, today);
  const start = parsed.ok && parsed.iso !== null ? parsed.iso : WHEEL_START;

  return (
    <div className="relative">
      <input
        {...control}
        type="text"
        inputMode="numeric"
        autoComplete="bday"
        enterKeyHint="done"
        maxLength={10}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(maskBirthDateInput(event.target.value))}
        data-testid="birth-date-input"
        className={`${INPUT} pr-14 tabular-nums`}
      />
      <button
        type="button"
        aria-label={t.openCalendar}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid="birth-date-picker"
        className={`absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground hover:bg-border/60 disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
      >
        <CalendarIcon width={20} height={20} aria-hidden="true" />
      </button>
      <DateWheelSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t.birthDate}
        initial={start > today ? today : start}
        min={MIN_BIRTH_DATE}
        max={today}
        months={t.months}
        labels={{
          day: t.pickerDay,
          month: t.pickerMonth,
          year: t.pickerYear,
          done: t.pickerDone,
          close: t.close,
        }}
        onDone={(iso) => {
          onChange(isoToDisplay(iso));
          setOpen(false);
        }}
      />
    </div>
  );
}
