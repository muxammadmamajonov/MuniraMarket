'use client';

import type { DeliverySlotOption } from '@muniramarket/contracts';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage, formatPlural } from '@/i18n/format';
import type { SlotFailureReason } from '@/lib/checkout/failures';
import {
  LOW_REMAINING_THRESHOLD,
  dayAvailability,
  dayLabel,
  defaultDay,
  groupSlotsByDay,
  hasBookableSlot,
  isSlotFull,
  revealOffset,
  slotWindow,
  type SlotDay,
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
 * Two steps in one card: a row of day chips, then the windows of the chosen day.
 *
 * **Days are a tablist, not a radiogroup.** The day is not a value of the order: it only decides
 * which windows are on screen, and nothing is validated or sent for it. That is exactly a tab
 * ("show this view"), and it leaves the one real form value, the window, as the only `radiogroup`
 * (required, invalid, described by the notice) inside the shown panel. Day radios would have made
 * two required-looking groups out of one choice. The tabs follow the automatic-activation pattern
 * of the ARIA Authoring Practices: roving tabindex (only the shown day is in the tab order),
 * Left/Right with wrap-around, Home and End; moving focus shows the day, so there is nothing to
 * confirm. Disabled states use `aria-disabled` rather than `disabled`, so a chip that is briefly
 * inert (an order is being sent) does not throw the keyboard user's focus away.
 *
 * **No layout shift.** Every day's panel is rendered in the same grid cell and the hidden ones are
 * `visibility: hidden`, so the card is always as tall as the busiest day and switching days only
 * toggles visibility: nothing below it moves. Hidden panels are out of the accessibility tree and
 * the tab order. The chosen window therefore survives a day change as plain state, and its radio
 * is simply in a panel that is not shown; its chip carries a check mark and a screen-reader note.
 *
 * **Day chips** scroll horizontally on their own (the page never does, even at 320px), snap to
 * their start edge, and the shown chip is scrolled into view (instantly, by moving the row only
 * so the page does not jump) whenever the day changes, including the first render. Chips are 56px
 * tall with 8px gaps. The scroll padding follows the left/right safe-area inset: the app pads the
 * page by `env(safe-area-inset-*)` only at the top and bottom, and the row is the one element that
 * scrolls under a landscape notch.
 *
 * **Motion.** Switching a day is instant: it is repeated often, often from the keyboard, and a
 * transition would only delay the windows the customer came for. Chips and tiles give press
 * feedback (`transform` 150ms, strong ease-out) and nothing else moves; reduced motion is handled
 * by the global rule and `motion-reduce:transition-none`.
 *
 * The windows are native radios inside one `radiogroup` (arrows skip full windows, which are
 * disabled), shown as tiles: a large target (min 56px, two per row at 360px) whose checked state
 * is a border, a ring and a check mark, never colour alone. Full windows stay visible but struck
 * through and labelled, and fully booked days stay in the row marked "full", so the customer sees
 * a busy day rather than wondering where it went. Each radio's accessible name carries its day
 * ("Today, 31.10, 10:00–12:00").
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
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRef = useRef<HTMLDivElement>(null);

  const days = groupSlotsByDay(slots);
  const headingId = `${baseId}-title`;
  const hintId = `${baseId}-hint`;
  const noticeId = `${baseId}-notice`;
  const elsewhereId = `${baseId}-elsewhere`;
  const tabId = (date: string) => `${baseId}-tab-${date}`;
  const panelId = (date: string) => `${baseId}-panel-${date}`;
  const bookable = hasBookableSlot(slots);
  const inert = disabled || stale;

  // The shown day is remembered once it is known, so a later change of the chosen window (it was
  // cleared, or filled up) never moves the customer to another day under their finger. It falls
  // back to the default only when the remembered day is no longer offered.
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const activeDay =
    chosenDay !== null && days.some((day) => day.date === chosenDay)
      ? chosenDay
      : defaultDay(days, selectedId);
  if (activeDay !== chosenDay) setChosenDay(activeDay);

  const selectedDay = days.find((day) => day.slots.some((slot) => slot.id === selectedId)) ?? null;
  const selectedSlot = selectedDay?.slots.find((slot) => slot.id === selectedId) ?? null;
  const chosenElsewhere =
    selectedDay !== null && selectedSlot !== null && selectedDay.date !== activeDay;
  const describedBy = [
    hintId,
    notice === null ? null : noticeId,
    chosenElsewhere ? elsewhereId : null,
  ]
    .filter((id) => id !== null)
    .join(' ');

  // Keep the shown chip in view (first render and every change), moving the row only.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const tab = activeDay === null ? undefined : tabRefs.current.get(activeDay);
    if (row === null || tab === undefined) return;
    const style = getComputedStyle(row);
    const padding = Math.max(
      Number.parseFloat(style.scrollPaddingLeft) || 0,
      Number.parseFloat(style.scrollPaddingRight) || 0,
    );
    const next = revealOffset({
      viewStart: row.scrollLeft,
      viewSize: row.clientWidth,
      contentSize: row.scrollWidth,
      itemStart: tab.offsetLeft,
      itemSize: tab.offsetWidth,
      padding,
    });
    if (next !== row.scrollLeft) row.scrollLeft = next;
  }, [activeDay]);

  const showDay = (date: string) => {
    if (!inert) setChosenDay(date);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inert || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const count = days.length;
    const index = days.findIndex((day) => day.date === activeDay);
    let target = -1;
    if (event.key === 'ArrowRight') target = (index + 1) % count;
    else if (event.key === 'ArrowLeft') target = (index - 1 + count) % count;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = count - 1;
    const day = days[target];
    if (day === undefined) return;
    event.preventDefault();
    setChosenDay(day.date);
    tabRefs.current.get(day.date)?.focus();
  };

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
        <div className="flex min-w-0 flex-col gap-3">
          <div
            ref={rowRef}
            role="tablist"
            aria-label={t.daysLabel}
            data-testid="delivery-day-row"
            onKeyDown={onTabKeyDown}
            className={
              'relative -mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-4 py-1 ' +
              'scroll-pl-[max(1rem,env(safe-area-inset-left,0px))] scroll-pr-[max(1rem,env(safe-area-inset-right,0px))] ' +
              '[scrollbar-width:thin] transition-opacity duration-150 ease-out motion-reduce:transition-none ' +
              (inert ? 'opacity-60' : '')
            }
          >
            {days.map((day) => {
              const label = dayLabel(day.date, today, t);
              return (
                <DayTab
                  key={day.date}
                  id={tabId(day.date)}
                  panelId={panelId(day.date)}
                  day={day}
                  name={label.name}
                  date={label.date}
                  text={label.text}
                  active={day.date === activeDay}
                  holdsChoice={selectedDay?.date === day.date}
                  inert={inert}
                  onShow={showDay}
                  register={(element) => {
                    if (element === null) tabRefs.current.delete(day.date);
                    else tabRefs.current.set(day.date, element);
                  }}
                />
              );
            })}
          </div>

          {chosenElsewhere && selectedSlot !== null && selectedDay !== null ? (
            <p id={elsewhereId} className="sr-only" data-testid="slot-chosen-elsewhere">
              {formatMessage(t.chosenElsewhere, {
                when: `${dayLabel(selectedDay.date, today, t).text}, ${slotWindow(selectedSlot)}`,
              })}
            </p>
          ) : null}

          <div className="grid min-w-0">
            {days.map((day) => {
              const label = dayLabel(day.date, today, t);
              const active = day.date === activeDay;
              return (
                <div
                  key={day.date}
                  id={panelId(day.date)}
                  role="tabpanel"
                  aria-labelledby={tabId(day.date)}
                  data-day={day.date}
                  style={active ? undefined : { visibility: 'hidden' }}
                  className="col-start-1 row-start-1 min-w-0"
                >
                  <div
                    role="radiogroup"
                    aria-labelledby={headingId}
                    {...(active
                      ? {
                          'aria-describedby': describedBy,
                          'aria-required': required ? true : undefined,
                          'aria-invalid': notice === null ? undefined : true,
                          'data-field': 'deliverySlot',
                          tabIndex: -1,
                        }
                      : {})}
                    data-testid="delivery-slot-group"
                    className={`grid min-w-0 grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 rounded-xl outline-none transition-opacity duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus motion-reduce:transition-none ${inert ? 'opacity-60' : ''}`}
                  >
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

interface DayTabProps {
  id: string;
  panelId: string;
  day: SlotDay;
  /** "Today", "Tomorrow" or the weekday. */
  name: string;
  /** `03.11`. */
  date: string;
  /** `Today, 31.10`. */
  text: string;
  active: boolean;
  /** The chosen window is on this day (which may not be the day that is shown). */
  holdsChoice: boolean;
  inert: boolean;
  onShow: (date: string) => void;
  register: (element: HTMLButtonElement | null) => void;
}

/**
 * One day chip. 56px tall, content-sized (never truncated: the row scrolls instead), a compact
 * "N free" hint or "full" under the date. A full day is still a chip you can open, so the customer
 * can see it is booked. The shown chip has a darker, thicker border (ring) and a tinted background,
 * not colour alone; the chip holding the chosen window has a check mark.
 */
function DayTab({
  id,
  panelId,
  day,
  name,
  date,
  text,
  active,
  holdsChoice,
  inert,
  onShow,
  register,
}: DayTabProps) {
  const { dict } = useI18n();
  const t = dict.checkout.slots;
  const { free, full } = dayAvailability(day);
  const hint = full ? t.full : formatMessage(t.dayFree, { count: free });
  const label = `${text}, ${hint}${holdsChoice ? `, ${t.dayChosen}` : ''}`;

  return (
    <button
      ref={register}
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={panelId}
      aria-label={label}
      aria-disabled={inert ? true : undefined}
      tabIndex={active ? 0 : -1}
      data-testid="delivery-day-tab"
      data-date={day.date}
      data-full={full ? 'true' : undefined}
      onClick={() => onShow(day.date)}
      className={
        'group relative flex min-h-14 shrink-0 snap-start touch-manipulation flex-col items-center justify-center gap-0.5 rounded-xl border px-4 py-2 text-center whitespace-nowrap select-none [-webkit-touch-callout:none] ' +
        'transition-[transform,background-color,border-color] duration-150 ease-out-strong motion-reduce:transition-none ' +
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus ' +
        'aria-disabled:cursor-not-allowed ' +
        (full ? 'border-dashed ' : '') +
        (active
          ? 'border-primary bg-surface-muted ring-1 ring-primary '
          : 'border-border bg-surface hover:bg-surface-muted ') +
        (inert ? '' : 'cursor-pointer active:scale-[0.97]')
      }
    >
      <span className="text-sm font-semibold">{name}</span>
      <span data-money className="text-xs text-muted-foreground">
        {date}
      </span>
      <span className={`text-xs ${full ? 'text-muted-foreground' : 'font-medium'}`}>{hint}</span>
      {holdsChoice ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          data-testid="delivery-day-chosen"
          className="absolute top-1 right-1 size-3.5 text-primary"
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
      ) : null}
    </button>
  );
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
