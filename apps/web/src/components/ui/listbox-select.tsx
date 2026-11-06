'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { PRESS } from '../ui-classes';

/** Must be at least the exit duration (`duration-100`) below; the popup stays mounted this long. */
const EXIT_MS = 100;
const TYPEAHEAD_MS = 600;

export interface ListboxOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ListboxGroup {
  id: string;
  /** Header text, also the accessible name of the group. */
  label: string;
  options: readonly ListboxOption[];
}

export interface ListboxSelectProps {
  /** Flat options. Ignored when `groups` is given. */
  options?: readonly ListboxOption[];
  groups?: readonly ListboxGroup[];
  /** The selected option's value; `''` (or an unknown value) shows the placeholder. */
  value: string;
  onChange: (value: string) => void;
  /** Shown in the trigger while nothing is chosen. */
  placeholder?: string;
  /** Trigger id; `FormField` hands this over so its `<label htmlFor>` labels the trigger. */
  id?: string;
  /** Submitted with a native form through a hidden input. */
  name?: string;
  disabled?: boolean;
  /** Space-separated ids of the element(s) that label the control (the trigger's own id is added). */
  'aria-labelledby'?: string;
  /** Accessible name of the popup list (falls back to `aria-labelledby`). */
  label?: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
  'aria-required'?: true | undefined;
  /** `data-field` of the trigger, so a form can focus it. */
  dataField?: string;
  onBlur?: () => void;
  /** Classes of the wrapper (width, margins). */
  className?: string;
}

interface FlatOption extends ListboxOption {
  index: number;
  groupId: string | null;
}

function flatten(
  options: readonly ListboxOption[] | undefined,
  groups: readonly ListboxGroup[] | undefined,
): FlatOption[] {
  const flat: FlatOption[] = [];
  const push = (option: ListboxOption, groupId: string | null) =>
    flat.push({ ...option, index: flat.length, groupId });
  if (groups !== undefined) {
    for (const group of groups) for (const option of group.options) push(option, group.id);
  } else {
    for (const option of options ?? []) push(option, null);
  }
  return flat;
}

const isPrintable = (event: ReactKeyboardEvent) =>
  event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;

/**
 * Fully custom select, the WAI-ARIA "select-only combobox" pattern: a `button[role=combobox]`
 * that opens a `role=listbox` (focus stays on the trigger; the highlighted option is exposed with
 * `aria-activedescendant`). Below 640px the list is a bottom sheet over a backdrop, from 640px a
 * popover under the trigger. Only `transform` and `opacity` animate; `motion-reduce` makes the
 * change instant.
 *
 * Keys: Enter / Space / ArrowDown / ArrowUp open; ArrowUp/ArrowDown move, Home / End jump, letters
 * jump to the next option starting with them, Enter / Space choose, Escape closes and keeps focus
 * on the trigger, Tab closes without choosing. A press outside closes.
 */
export function ListboxSelect({
  options,
  groups,
  value,
  onChange,
  placeholder = '',
  id,
  name,
  disabled = false,
  'aria-labelledby': labelledBy,
  label,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-required': required,
  dataField,
  onBlur,
  className,
}: ListboxSelectProps) {
  const autoId = useId();
  const triggerId = id ?? `${autoId}-trigger`;
  const listId = `${autoId}-list`;
  const optionId = (index: number) => `${autoId}-opt-${index}`;
  const groupHeaderId = (groupId: string) => `${autoId}-group-${groupId}`;

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', timer: undefined as ReturnType<typeof setTimeout> | undefined });

  const flat = flatten(options, groups);
  const selected = flat.find((option) => option.value === value && value !== '');
  const isOpen = open && !disabled;
  if (isOpen && !mounted) setMounted(true);

  useEffect(() => {
    if (isOpen || !mounted) return undefined;
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [isOpen, mounted]);

  useEffect(() => () => clearTimeout(typed.current.timer), []);

  // Press outside closes.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [isOpen]);

  // Keep the highlighted option visible without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    if (!isOpen || list === null || active < 0) return;
    const element = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (element === null) return;
    const top = element.offsetTop;
    const bottom = top + element.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [active, isOpen]);

  const firstEnabled = () => flat.find((option) => option.disabled !== true)?.index ?? -1;
  const lastEnabled = () => flat.filter((option) => option.disabled !== true).at(-1)?.index ?? -1;
  const step = (from: number, direction: 1 | -1) => {
    for (let i = from + direction; i >= 0 && i < flat.length; i += direction) {
      if (flat[i]?.disabled !== true) return i;
    }
    return from;
  };

  const openPopup = (at?: number) => {
    if (disabled) return;
    setActive(at ?? selected?.index ?? firstEnabled());
    setOpen(true);
  };
  const closePopup = () => setOpen(false);

  const choose = (index: number) => {
    const option = flat[index];
    if (option === undefined || option.disabled === true) return;
    if (option.value !== value) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const typeahead = (key: string) => {
    const state = typed.current;
    clearTimeout(state.timer);
    state.text += key.toLowerCase();
    state.timer = setTimeout(() => (state.text = ''), TYPEAHEAD_MS);
    const repeated = [...state.text].every((char) => char === state.text[0]);
    const needle = repeated ? (state.text[0] ?? '') : state.text;
    const start = isOpen ? active + (repeated ? 1 : 0) : 0;
    for (let i = 0; i < flat.length; i += 1) {
      const option = flat[(Math.max(start, 0) + i) % flat.length];
      if (
        option !== undefined &&
        option.disabled !== true &&
        option.label.toLowerCase().startsWith(needle)
      )
        return option.index;
    }
    return -1;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;
    if (!isOpen) {
      if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        openPopup();
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        openPopup(key === 'Home' ? firstEnabled() : lastEnabled());
      } else if (isPrintable(event)) {
        const match = typeahead(key);
        if (match >= 0) openPopup(match);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(active < 0 ? firstEnabled() : step(active, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive(active < 0 ? lastEnabled() : step(active, -1));
        break;
      case 'Home':
        event.preventDefault();
        setActive(firstEnabled());
        break;
      case 'End':
        event.preventDefault();
        setActive(lastEnabled());
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (active >= 0) choose(active);
        else closePopup();
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closePopup();
        triggerRef.current?.focus({ preventScroll: true });
        break;
      case 'Tab':
        // Chooses nothing; focus moves on as usual.
        closePopup();
        break;
      default:
        if (isPrintable(event)) {
          const match = typeahead(key);
          if (match >= 0) setActive(match);
        }
    }
  };

  const closing = !isOpen;
  const listName =
    label === undefined ? { 'aria-labelledby': labelledBy } : { 'aria-label': label };

  const renderOption = (option: FlatOption): ReactNode => {
    const isSelected = option.index === selected?.index;
    const isActive = option.index === active;
    return (
      <div
        key={option.value}
        id={optionId(option.index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={option.disabled === true ? true : undefined}
        data-index={option.index}
        data-value={option.value}
        data-active={isActive ? 'true' : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          if (!isActive && option.disabled !== true) setActive(option.index);
        }}
        onClick={() => choose(option.index)}
        className={
          'flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-base select-none [overflow-wrap:anywhere] ' +
          (option.disabled === true
            ? 'cursor-not-allowed text-muted-foreground opacity-60 '
            : 'cursor-pointer ') +
          (isSelected
            ? `bg-brand-soft font-medium text-brand-ink ${isActive ? 'ring-1 ring-border-strong ring-inset' : ''}`
            : isActive
              ? 'bg-surface-muted'
              : '')
        }
      >
        <span className="min-w-0">{option.label}</span>
        {isSelected ? (
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        ) : null}
      </div>
    );
  };

  const flatByGroup = (groupId: string) => flat.filter((option) => option.groupId === groupId);

  return (
    <div className={`relative min-w-0 ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-labelledby={labelledBy === undefined ? undefined : `${labelledBy} ${triggerId}`}
        aria-activedescendant={isOpen && active >= 0 ? optionId(active) : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={required}
        data-field={dataField}
        disabled={disabled}
        onClick={() => (isOpen ? closePopup() : openPopup())}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          // Firefox activates a button on Space keyup; keydown already handled it.
          if (event.key === ' ') event.preventDefault();
        }}
        onBlur={onBlur}
        className={
          'flex min-h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-left text-base text-foreground ' +
          'aria-[invalid=true]:border-danger focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus ' +
          'disabled:cursor-not-allowed disabled:opacity-50 ' +
          PRESS
        }
      >
        <span
          className={`min-w-0 [overflow-wrap:anywhere] ${selected === undefined ? 'text-muted-foreground' : ''}`}
        >
          {selected === undefined ? placeholder : selected.label}
        </span>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-muted-foreground transition-transform duration-150 ease-out-strong motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {name === undefined ? null : <input type="hidden" name={name} value={value} />}

      {mounted ? (
        <>
          <div
            aria-hidden="true"
            data-testid="listbox-backdrop"
            data-closing={closing}
            className={
              'fixed inset-0 z-40 bg-overlay opacity-100 transition-opacity duration-150 ease-out-strong sm:hidden ' +
              'starting:opacity-0 data-[closing=true]:pointer-events-none data-[closing=true]:opacity-0 data-[closing=true]:duration-100 ' +
              'motion-reduce:transition-none'
            }
          />
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            {...listName}
            aria-hidden={closing ? true : undefined}
            data-closing={closing}
            className={
              // Phone: bottom sheet. From 640px: popover under the trigger, growing from its top edge.
              'fixed inset-x-0 bottom-0 z-50 max-h-[60dvh] overflow-y-auto overscroll-contain rounded-t-2xl border border-border bg-surface pb-(--mm-inset-bottom) shadow-xl outline-none ' +
              'sm:absolute sm:inset-x-0 sm:top-full sm:bottom-auto sm:mt-1 sm:max-h-72 sm:origin-top sm:rounded-xl sm:pb-0 ' +
              'translate-y-0 scale-100 opacity-100 transition-[transform,opacity] duration-160 ease-out-strong ' +
              'starting:translate-y-full starting:opacity-0 sm:starting:translate-y-0 sm:starting:scale-[0.97] ' +
              'data-[closing=true]:pointer-events-none data-[closing=true]:translate-y-full data-[closing=true]:opacity-0 data-[closing=true]:duration-100 ' +
              'sm:data-[closing=true]:translate-y-0 sm:data-[closing=true]:scale-[0.97] ' +
              'motion-reduce:transition-none'
            }
          >
            {groups === undefined
              ? flat.map(renderOption)
              : groups.map((group) => (
                  <div key={group.id} role="group" aria-labelledby={groupHeaderId(group.id)}>
                    <div
                      id={groupHeaderId(group.id)}
                      role="presentation"
                      className="px-3 pt-3 pb-1 text-sm font-semibold text-muted-foreground [overflow-wrap:anywhere]"
                    >
                      {group.label}
                    </div>
                    {flatByGroup(group.id).map(renderOption)}
                  </div>
                ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
