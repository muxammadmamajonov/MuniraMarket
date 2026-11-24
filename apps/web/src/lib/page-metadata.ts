import type { Metadata } from 'next';
import { isLocale } from '@muniramarket/contracts';
import { getDictionary } from '@/i18n';
import type { Dictionary } from '@/i18n';
import { pageAlternates } from '@/lib/site';

/** "Cart · MuniraMarket": the page title with the shop's name, as the help page already does. */
export function pageTitle(dict: Dictionary, title: string): string {
  return `${title} · ${dict.meta.title}`;
}

/** Pages that belong to one visitor (or are endless query variations): kept out of search engines. */
export const NO_INDEX: Metadata['robots'] = { index: false, follow: false };

type PageTitleKey = keyof Dictionary['pageTitles'];

/**
 * `generateMetadata` for a page whose title is one of `dict.pageTitles`. `indexable: false` (the
 * default) also sets `noindex`: cart, checkout, orders, profile and search are private or thin.
 * An indexable page with a `path` (locale-less, e.g. `/catalog`) also gets its canonical URL and
 * `hreflang` alternates.
 */
export function titledMetadata(
  key: PageTitleKey,
  options: { indexable?: boolean; path?: string } = {},
) {
  return async ({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> => {
    const { locale } = await params;
    if (!isLocale(locale)) return {};
    const dict = getDictionary(locale);
    return {
      title: pageTitle(dict, dict.pageTitles[key]),
      ...(options.indexable === true
        ? options.path === undefined
          ? {}
          : { alternates: pageAlternates(locale, options.path) }
        : { robots: NO_INDEX }),
    };
  };
}
