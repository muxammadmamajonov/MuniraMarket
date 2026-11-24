import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '@muniramarket/contracts';
import type { Metadata } from 'next';

/** The storefront's public origin: what search engines and link previews see. */
const DEFAULT_SITE_ORIGIN = 'https://muniramarket.uz';

/**
 * Public origin of the storefront (no trailing slash), used for canonical URLs, `hreflang`,
 * OpenGraph and the sitemap. Production is pinned to `muniramarket.uz`; `SITE_ORIGIN` overrides it
 * (a staging deployment) and is read at request time. An unset or malformed value (not an http(s)
 * origin) falls back to the default instead of emitting broken absolute URLs.
 */
export function siteOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env['SITE_ORIGIN']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SITE_ORIGIN;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : DEFAULT_SITE_ORIGIN;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}

/** Locale-prefixed path: `localePath('uz', '/p/rice')` is `/uz/p/rice`; the home page is `/uz`. */
export function localePath(locale: Locale, path: string): string {
  return `/${locale}${path === '/' ? '' : path}`;
}

/**
 * `alternates` for an indexable page: its own canonical URL and one `hreflang` per language
 * (plus `x-default`, the default language). `path` is the locale-less path, e.g. `/catalog`.
 * Relative to `metadataBase`, which the root layout sets from {@link siteOrigin}.
 */
export function pageAlternates(locale: Locale, path: string): NonNullable<Metadata['alternates']> {
  const languages: Record<string, string> = {};
  for (const l of SUPPORTED_LOCALES) languages[l] = localePath(l, path);
  languages['x-default'] = localePath(DEFAULT_LOCALE, path);
  return { canonical: localePath(locale, path), languages };
}

/** OpenGraph `locale` value for a page language. */
export const OG_LOCALE: Record<Locale, string> = { uz: 'uz_UZ', ru: 'ru_RU' };

/** The share image when a page has no photo of its own: the shop's square badge. */
export const DEFAULT_SHARE_IMAGE = {
  url: '/brand/munira-logo-badge-1024.png',
  width: 1024,
  height: 1024,
  alt: 'MuniraMarket',
} as const;
