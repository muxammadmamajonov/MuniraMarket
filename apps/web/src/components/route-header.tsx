'use client';

import { usePathname } from 'next/navigation';
import { useI18n } from '@/i18n/context';
import { staticTitleFor } from '@/lib/back-navigation';
import { SiteHeader } from './site-header';

export interface RouteHeaderProps {
  /** Shells that replace a page: their own title instead of the page's. */
  kind?: 'notFound' | 'error';
}

/**
 * The header for the shells that render before a page (`loading.tsx`), instead of it
 * (`not-found.tsx`, `error.tsx`), or without the page's data (the sign-in callback). The title
 * follows the URL (`staticTitleFor`: the logo at home, an empty slot where the title would come
 * from data), or the shell's own kind.
 */
export function RouteHeader({ kind }: RouteHeaderProps) {
  const { dict, locale } = useI18n();
  const pathname = usePathname();
  const title = kind === undefined ? staticTitleFor(pathname, dict) : dict.pageTitles[kind];
  return <SiteHeader locale={locale} dict={dict} title={title} />;
}
