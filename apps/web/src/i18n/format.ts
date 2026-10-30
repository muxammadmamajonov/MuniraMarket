import type { Locale } from '@muniramarket/contracts';
import type { PluralForms } from './dictionaries/types';

/**
 * Fills `{name}` placeholders in a dictionary string. Unknown placeholders are left as they are so
 * a missing value is visible rather than silently dropped.
 */
export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Picks the noun form for `count` by CLDR plural category (`Intl.PluralRules`) and fills
 * `{count}`. Russian: 1 товар, 2 товара, 5 товаров, 21 товар. Uzbek defines the same text for
 * every category, so it never depends on ICU's plural data for `uz`.
 */
export function formatPlural(forms: PluralForms, count: number, locale: Locale): string {
  const category = new Intl.PluralRules(locale === 'ru' ? 'ru' : 'en').select(count);
  // `en` only produces `one` / `other`; Uzbek forms are identical, so that is enough for it.
  const key: keyof PluralForms =
    category === 'one' || category === 'few' || category === 'many' ? category : 'other';
  return formatMessage(forms[key], { count });
}
