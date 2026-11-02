import type { Locale } from '@muniramarket/contracts';
import type { Dictionary } from '@/i18n';
import { SearchIcon } from './icons';
import { SearchField } from './search-field';
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
 * global rule that stops iOS Safari from zooming on focus), a plain text field (no browser cancel
 * "x"; see `SearchField` for the custom clear button) with a search key on the on-screen keyboard.
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
      <SearchField
        defaultValue={defaultValue}
        placeholder={dict.search.placeholder}
        label={dict.search.label}
        clearLabel={dict.search.clear}
      />
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
