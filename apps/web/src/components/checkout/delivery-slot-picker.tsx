'use client';

import type { DeliverySlotOption } from '@muniramarket/contracts';
import { useId } from 'react';
import { useI18n } from '@/i18n/context';
import { formatPlural } from '@/i18n/format';
import type { SlotFailureReason } from '@/lib/checkout/failures';
import {
  LOW_REMAINING_THRESHOLD,
  dayLabel,
  groupSlotsByDay,
  hasBookableSlot,
  isSlotFull,
  slotWindow,
} from '@/lib/checkout/slots';
import { CARD, ERROR_TEXT, FOCUS_RING, PRESS } from '../ui-classes';

export interface DeliverySlotPickerProps {
  slots: readonly DeliverySlotOption[];
  selectedId: string | null;
  /** The zone needs a window: the order cannot be placed without one. */
  required: boolean;
  /** An order is being sent. */
  disabled: boolean;
  /** The windows shown are from the previous quote while a new one is being fetched. */
  stale: boolean;
  /** Why the last attempt to book failed, shown next to the choices. */
  notice: SlotFailureReason | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  /** `YYYY-MM-DD` in Tashkent: the day "Today" refers to. */
  today: string;
}

/**
 * The options use one native radio per window inside a single `radiogroup`, so the browser gives
 * arrow-key movement, selection and screen-reader semantics for free (arrows skip full windows,
 * which are disabled). Windows are tiles: a large target (min 56px, two per row at 360px) whose
 * checked state is a border, a ring and a check mark, never colour alone. Full windows stay visible
 * but struck through and labelled, so the customer sees the day is busy rather than wondering
 * where a time went. The day headings are visual: each radio's accessible name already carries
 * its day ("Today, 31.10, 10:00–12:00"), so they are hidden from assistive technology rather than
 * announced twice.
 */
export function DeliverySlotPicker({
  slots,
  selectedId,
  required,
  disabled,
  stale,
  notice,
  onSelect,
  onClear,
  today,
}: DeliverySlotPickerProps) {
  const { dict, locale } = useI18n();
  const t = dict.checkout.slots;
  const baseId = useId();

  const days = groupSlotsByDay(slots);
  const headingId = `${baseId}-title`;
  const hintId = `${baseId}-hint`;
  const noticeId = `${baseId}-notice`;
  const bookable = hasBookableSlot(slots);
  const inert = disabled || stale;
  const describedBy = [hintId, notice === null ? null : noticeId]
    .filter((id) => id !== null)
    .join(' ');

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={stale}
      data-testid="delivery-slots"
      className={`${CARD} mm-enter flex min-w-0 flex-col gap-4`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-bold">
          {t.title}
        </h2>
        <p id={hintId} className="text-sm text-muted-foreground">
          {required ? t.hintRequired : t.hintOptional}
        </p>
      </div>

      {days.length === 0 ? null : (
        <div
          role="radiogroup"
          aria-labelledby={headingId}
          aria-describedby={describedBy}
          aria-required={required ? true : undefined}
          aria-invalid={notice === null ? undefined : true}
          data-field="deliverySlot"
          data-testid="delivery-slot-group"
          tabIndex={-1}
          className={`flex min-w-0 flex-col gap-4 rounded-xl outline-none transition-opacity duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus ${inert ? 'opacity-60' : ''}`}
        >
          {days.map((day) => {
            const label = dayLabel(day.date, today, t);
            return (
              <div key={day.date} className="flex min-w-0 flex-col gap-2" data-day={day.date}>
                <p aria-hidden="true" className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-semibold">{label.name}</span>
                  <span data-money className="text-muted-foreground">
                    {label.date}
                  </span>
                </p>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
                  {day.slots.map((slot) => (
                    <SlotTile
                      key={slot.id}
                      slot={slot}
                      dayText={label.text}
                      checked={selectedId === slot.id}
                      disabled={inert}
                      onSelect={onSelect}
                      remainingText={remainingText(slot, (count) =>
                        formatPlural(t.remaining, count, locale),
                      )}
                      fullText={t.full}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {notice === null ? null : (
        <p
          id={noticeId}
          role="alert"
          data-testid="slot-notice"
          data-reason={notice}
          className={ERROR_TEXT}
        >
          {t.notice[notice]}
        </p>
      )}
      {bookable ? null : (
        <p role="status" data-testid="slots-none" className="text-sm font-medium">
          {t.noneAvailable}
        </p>
      )}
      {!required && selectedId !== null ? (
        <button
          type="button"
          disabled={inert}
          onClick={onClear}
          data-testid="slot-clear"
          className={`inline-flex min-h-11 items-center self-start rounded-xl px-1 text-sm font-semibold underline underline-offset-4 disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
        >
          {t.clear}
        </button>
      ) : null}
    </section>
  );
}

/** "2 places left" for a window that is nearly gone, nothing for a comfortable one. */
function remainingText(slot: DeliverySlotOption, plural: (count: number) => string): string | null {
  if (isSlotFull(slot) || slot.remaining > LOW_REMAINING_THRESHOLD) return null;
  return plural(slot.remaining);
}

interface SlotTileProps {
  slot: DeliverySlotOption;
  dayText: string;
  checked: boolean;
  disabled: boolean;
  remainingText: string | null;
  fullText: string;
  onSelect: (id: string) => void;
}

function SlotTile({
  slot,
  dayText,
  checked,
  disabled,
  remainingText: remaining,
  fullText,
  onSelect,
}: SlotTileProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const full = isSlotFull(slot);
  const note = full ? fullText : remaining;

  return (
    <label
      data-testid="delivery-slot-option"
      data-slot-id={slot.id}
      data-full={full ? 'true' : undefined}
      className={
        'group relative flex min-h-14 min-w-0 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-surface px-3 py-2 text-center select-none [-webkit-touch-callout:none] ' +
        'transition-[transform,background-color,border-color,box-shadow] duration-150 ease-out-strong motion-reduce:transition-none ' +
        'has-focus-visible:transition-none has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus ' +
        (full
          ? 'cursor-not-allowed border-dashed bg-surface-muted text-muted-foreground'
          : 'cursor-pointer has-enabled:hover:bg-surface-muted has-enabled:active:scale-[0.97] has-checked:border-primary has-checked:bg-surface-muted has-checked:ring-1 has-checked:ring-primary')
      }
    >
      <input
        type="radio"
        name="deliverySlot"
        value={slot.id}
        checked={checked}
        disabled={disabled || full}
        onChange={() => onSelect(slot.id)}
        aria-label={`${dayText}, ${slotWindow(slot)}`}
        aria-describedby={note === null ? undefined : noteId}
        className="sr-only"
      />
      <span data-money className={`min-w-0 font-semibold ${full ? 'line-through' : ''}`}>
        {slotWindow(slot)}
      </span>
      {note === null ? null : (
        <span
          id={noteId}
          className={`text-xs ${full ? '' : 'font-medium text-amber-800 dark:text-amber-300'}`}
        >
          {note}
        </span>
      )}
      {full ? null : (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="absolute top-1.5 right-1.5 size-4 text-primary opacity-0 transition-opacity duration-100 ease-out group-has-checked:opacity-100 group-has-focus-visible:transition-none"
        >
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </label>
  );
}
