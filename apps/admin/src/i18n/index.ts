import type { Locale } from '@muniramarket/contracts';
import { ru } from './dictionaries/ru';
import type { Dictionary } from './dictionaries/types';
import { uz } from './dictionaries/uz';

export type { Dictionary } from './dictionaries/types';

// `Record<Locale, Dictionary>` makes adding a locale to contracts a compile error until a
// dictionary exists for it.
const dictionaries: Record<Locale, Dictionary> = { uz, ru };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
