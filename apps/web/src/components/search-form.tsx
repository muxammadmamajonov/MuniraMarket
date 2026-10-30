import type { Locale } from '@muniramarket/contracts';
import type { Dictionary } from '@/i18n';

export interface SearchFormProps {
  locale: Locale;
  dict: Dictionary;
  /** Current query, to prefill on the search page. */
  defaultValue?: string;
  className?: string;
}

/** Plain GET form to `/<locale>/search?q=...`; works without JavaScript. */
export function SearchForm({ locale, dict, defaultValue = '', className }: SearchFormProps) {
  return (
    <form
      action={`/${locale}/search`}
      method="get"
      role="search"
      aria-label={dict.search.label}
      className={`flex gap-2 ${className ?? ''}`}
    >
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={dict.search.placeholder}
        aria-label={dict.search.label}
        minLength={2}
        maxLength={100}
        enterKeyHint="search"
        autoComplete="off"
        className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <button
        type="submit"
        className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {dict.search.submit}
      </button>
    </form>
  );
}
