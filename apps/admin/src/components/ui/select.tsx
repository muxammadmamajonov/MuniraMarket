'use client';

import { cx } from '@muniramarket/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { INPUT, INPUT_ON_PAGE } from './classes';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** First choice with the empty value ("All", "No parent", ...). */
  placeholder?: string;
  disabled?: boolean;
  /** Id of the visible label; the label names the control (APG select-only combobox). */
  labelledBy: string;
  id?: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean;
  testId?: string;
  className?: string;
  /** A filter on the page (white field) rather than a form field inside a white group. */
  onPage?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const TYPEAHEAD_RESET_MS = 700;

/**
 * The admin's select: a branded, select-only combobox (WAI-ARIA APG) instead of the browser's
 * native `<select>`, which cannot be styled consistently and opens OS pickers that differ per
 * device.
 *
 * - A button (`role="combobox"`, 44px tall, 16px text) shows the chosen label; the visible label
 *   names it through `aria-labelledby`.
 * - Opening shows a listbox under it; focus stays on the button and `aria-activedescendant`
 *   follows the highlighted option.
 * - Keys: Enter/Space/ArrowDown/ArrowUp open; arrows, Home/End and type-ahead move; Enter/Space
 *   choose; Escape and Tab close (Escape does not close a surrounding dialog).
 * - A pointer press outside closes it. Options can be disabled (and are skipped).
 *
 * Options carry `data-value`, which tests use to pick one.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  labelledBy,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  testId,
  className,
  onPage = false,
  ref,
}: SelectProps) {
  const listId = useId();
  const valueId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: '', at: 0 });

  const all: SelectOption[] =
    placeholder === undefined ? [...options] : [{ value: '', label: placeholder }, ...options];
  const selectedIndex = all.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? all[selectedIndex] : undefined;
  const optionId = (index: number) => `${listId}-o${String(index)}`;

  const enabled = (index: number) => all[index] !== undefined && all[index].disabled !== true;
  const step = (from: number, delta: 1 | -1): number => {
    for (let index = from + delta; index >= 0 && index < all.length; index += delta) {
      if (enabled(index)) return index;
    }
    return from;
  };
  const first = () => step(-1, 1);
  const last = () => step(all.length, -1);

  const openList = (highlight?: number) => {
    if (disabled) return;
    setActive(
      highlight ?? (selectedIndex >= 0 && enabled(selectedIndex) ? selectedIndex : first()),
    );
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const choose = (index: number) => {
    const option = all[index];
    if (option === undefined || option.disabled === true) return;
    close();
    if (option.value !== value) onChange(option.value);
  };

  // A press anywhere outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Keep the highlighted option in view while moving with the keyboard.
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // optionId is derived from listId, stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  /** Next enabled option whose label starts with what was typed (letters typed fast add up). */
  const typeahead = (key: string): number | null => {
    const now = Date.now();
    const text =
      (now - typed.current.at > TYPEAHEAD_RESET_MS ? '' : typed.current.text) + key.toLowerCase();
    typed.current = { text, at: now };
    const from = Math.max(open ? active : selectedIndex, 0);
    // A single letter moves on to the next match; a longer prefix may stay on the current one.
    const base = text.length > 1 ? from : from + 1;
    for (let offset = 0; offset < all.length; offset += 1) {
      const index = (base + offset) % all.length;
      if (enabled(index) && all[index]!.label.toLowerCase().startsWith(text)) return index;
    }
    return null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        openList(key === 'ArrowUp' && selectedIndex < 0 ? last() : undefined);
      } else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const match = typeahead(key);
        if (match !== null) openList(match);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current) => step(current, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => step(current, -1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(first());
        break;
      case 'End':
        event.preventDefault();
        setActive(last());
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        break;
      case 'Escape':
        event.preventDefault();
        // Close only the list, not a dialog around it.
        event.stopPropagation();
        close();
        break;
      case 'Tab':
        close();
        break;
      default:
        if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const match = typeahead(key);
          if (match !== null) setActive(match);
        }
    }
  };

  return (
    <div ref={wrapper} className={cx('relative min-w-0', className)}>
      <button
        ref={ref}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${labelledBy} ${valueId}`}
        aria-describedby={describedBy}
        aria-invalid={invalid === true ? true : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        data-testid={testId}
        data-value={value}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={cx(
          onPage ? INPUT_ON_PAGE : INPUT,
          'flex items-center justify-between gap-2 text-left',
          open && 'outline-2 outline-focus',
        )}
      >
        <span
          id={valueId}
          className={cx('min-w-0 truncate', selected === undefined && 'text-muted-foreground')}
        >
          {selected?.label ?? placeholder ?? ''}
        </span>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 20 20"
          className={cx(
            'size-5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
            open && 'rotate-180',
          )}
        >
          <path
            d="M5 8l5 5 5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          className="mm-popover absolute inset-x-0 top-[calc(100%+0.25rem)] z-40 max-h-72 min-w-48 overflow-y-auto overscroll-contain rounded-2xl border border-hairline bg-surface p-1.5 shadow-[0_12px_32px_-12px_rgb(20_20_22/0.35)]"
        >
          {all.map((option, index) => {
            const isSelected = index === selectedIndex;
            const isActive = index === active;
            return (
              <li
                key={`${option.value}-${String(index)}`}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled === true ? true : undefined}
                data-value={option.value}
                // Keep focus on the button (the combobox) while choosing with a pointer.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (option.disabled !== true) setActive(index);
                }}
                onClick={() => choose(index)}
                className={cx(
                  'flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-3 text-base break-words',
                  isActive && 'bg-surface-muted',
                  isSelected && 'font-semibold',
                  option.disabled === true && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className="min-w-0 flex-1">{option.label}</span>
                {isSelected ? (
                  <svg
                    aria-hidden="true"
                    focusable="false"
                    viewBox="0 0 20 20"
                    className="size-4 shrink-0 text-brand-ink"
                  >
                    <path
                      d="M4.5 10.5l3.5 3.5 7.5-8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
