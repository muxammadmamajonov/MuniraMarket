'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { SearchIcon } from './icons';

export interface SearchFieldProps {
  defaultValue: string;
  placeholder: string;
  label: string;
  clearLabel: string;
}

const noop = () => () => undefined;

/**
 * The text input of the search form: a plain `type="text"` field (no browser "x") with its own
 * clear button. Uncontrolled for submission, so the form works without JavaScript; the clear button
 * only appears once the page is interactive.
 */
export function SearchField({ defaultValue, placeholder, label, clearLabel }: SearchFieldProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon
        width={20}
        height={20}
        className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        name="q"
        defaultValue={defaultValue}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        minLength={2}
        maxLength={100}
        enterKeyHint="search"
        inputMode="search"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="min-h-12 w-full min-w-0 rounded-2xl border border-border bg-surface pr-12 pl-11 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
      />
      {hydrated && value !== '' ? (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => {
            setValue('');
            if (inputRef.current !== null) {
              inputRef.current.value = '';
              inputRef.current.focus();
            }
          }}
          className="absolute top-1/2 right-0.5 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
        >
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
