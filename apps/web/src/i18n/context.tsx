'use client';

import type { Locale } from '@muniramarket/contracts';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getDictionary, type Dictionary } from './index';

export interface I18nValue {
  locale: Locale;
  dict: Dictionary;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Makes the page locale and its dictionary available to client components. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, dict: getDictionary(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n must be used inside <LocaleProvider>.');
  return value;
}
