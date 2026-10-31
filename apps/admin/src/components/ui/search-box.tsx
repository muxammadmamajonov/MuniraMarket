'use client';

import { useEffect, useRef, useState } from 'react';
import { INPUT } from './classes';

/**
 * Search field of a list. Typing updates the URL after a short pause, Enter immediately; a URL that
 * changed from outside (back button, "reset filters") replaces the text. `value` is the URL's `q`.
 */
export function SearchBox({
  value,
  onSearch,
  label,
  placeholder,
  testId,
  delayMs = 350,
}: {
  value: string;
  onSearch: (query: string) => void;
  label: string;
  placeholder?: string | undefined;
  testId?: string | undefined;
  delayMs?: number;
}) {
  const [text, setText] = useState(value);
  // The last query this box pushed (or saw); a different `value` came from outside.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const push = (next: string) => {
    clearTimeout(timer.current);
    const query = next.trim();
    if (query === seen) return;
    setSeen(query);
    onSearch(query);
  };

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        push(text);
      }}
      className="min-w-0 flex-1 basis-56"
    >
      <input
        type="search"
        value={text}
        aria-label={label}
        placeholder={placeholder}
        data-testid={testId}
        maxLength={100}
        enterKeyHint="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setText(event.target.value);
          clearTimeout(timer.current);
          const next = event.target.value;
          timer.current = setTimeout(() => push(next), delayMs);
        }}
        className={INPUT}
      />
    </form>
  );
}
