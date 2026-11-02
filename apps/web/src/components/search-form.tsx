import type { Locale } from '@muniramarket/contracts';
import type { Dictionary } from '@/i18n';
import { SearchIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface SearchFormProps {
  locale: Locale;
  dict: Dictionary;
  /** Current query, to prefill on the search page. */
  defaultValue?: string;
  className?: string;
}

/**
 * Plain GET form to `/<locale>/search?q=...`; works without JavaScript. The input is 16px (the
 * global rule that stops iOS Safari from zooming on focus), `type="search"` with a search key on
 * the on-screen keyboard.
 */
export function SearchForm({ locale, dict, defaultValue = '', className }: SearchFormProps) {
  return (
    <form
      action={`/${locale}/search`}
      method="get"
      role="search"
      aria-label={dict.search.label}
      className={`flex gap-2 ${className ?? ''}`}
    >
      <div className="relative min-w-0 flex-1">
        <SearchIcon
          width={20}
          height={20}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder={dict.search.placeholder}
          aria-label={dict.search.label}
          minLength={2}
          maxLength={100}
          enterKeyHint="search"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="min-h-12 w-full min-w-0 rounded-2xl border border-border bg-surface pr-3 pl-11 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
        />
      </div>
      <button
        type="submit"
        className={`inline-flex min-h-12 min-w-12 items-center justify-center rounded-2xl bg-primary px-3 font-semibold sm:px-4 text-primary-foreground hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`}
      >
        {/* Icon only on the narrowest phones so the placeholder is not cut off. */}
        <SearchIcon width={22} height={22} className="sm:hidden" />
        <span className="sr-only sm:not-sr-only">{dict.search.submit}</span>
      </button>
    </form>
  );
}
