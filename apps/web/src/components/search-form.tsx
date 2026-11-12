import type { Locale } from '@muniramarket/contracts';
import type { Dictionary } from '@/i18n';
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
      {/* Phones submit with the keyboard's Search key (`enterKeyHint`), like native apps; the
          button is for wider screens, where a mouse user expects one. */}
      <button
        type="submit"
        className={`hidden min-h-12 items-center justify-center rounded-2xl bg-foreground px-5 font-semibold text-background hover:opacity-90 sm:inline-flex ${PRESS} ${FOCUS_RING}`}
      >
        {dict.search.submit}
      </button>
    </form>
  );
}
