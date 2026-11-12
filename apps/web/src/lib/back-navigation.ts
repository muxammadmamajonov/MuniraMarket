import type { Dictionary } from '@/i18n';
import { localeFromPathname } from '@/i18n/switch-locale';

/**
 * Back navigation for the app shell. There is no in-app back button anywhere: inside Telegram the
 * native `BackButton` is the only one (wired in `components/telegram-chrome.tsx`), in a browser
 * the browser's own. This module decides where it shows and where it leads.
 */

/** `/uz/c/fruits/` -> `['uz', 'c', 'fruits']`. */
function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/** Same path without a trailing slash, so `/uz/c/x/` and `/uz/c/x` compare equal. */
function normalize(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Root pages: the four bottom-nav tabs (Home, Catalog, Cart, Profile). They are where you go,
 * not somewhere you came down into, so they get no BackButton.
 */
export function isRootPath(pathname: string): boolean {
  if (localeFromPathname(pathname) === null) return false;
  const [, section, ...rest] = segments(pathname);
  if (rest.length > 0) return false;
  return (
    section === undefined || section === 'catalog' || section === 'cart' || section === 'profile'
  );
}

/** True for `/<locale>/checkout`, whose BackButton always returns to the cart. */
export function isCheckoutPath(pathname: string): boolean {
  const parts = segments(pathname);
  return localeFromPathname(pathname) !== null && parts.length === 2 && parts[1] === 'checkout';
}

/**
 * Where "back" leads when there is no history to go back to (the Mini App was opened straight on
 * a deep link). Pages that know better (a product knows its category) register their own parent
 * with {@link registerParent}.
 */
export function logicalParent(pathname: string): string {
  const locale = localeFromPathname(pathname);
  if (locale === null) return '/';
  const [, section, id] = segments(pathname);
  const home = `/${locale}`;
  switch (section) {
    case 'c':
    case 'p':
    case 'search':
      return `${home}/catalog`;
    case 'checkout':
      return `${home}/cart`;
    case 'orders':
      return id === undefined ? `${home}/profile` : `${home}/orders`;
    case 'help':
      return `${home}/profile`;
    default:
      return home;
  }
}

let registered: { path: string; href: string } | null = null;

/**
 * Overrides {@link logicalParent} for one path while the page is mounted. Returns the cleanup,
 * which only clears its own registration (the next page may already have registered).
 */
export function registerParent(pathname: string, href: string): () => void {
  const entry = { path: normalize(pathname), href };
  registered = entry;
  return () => {
    if (registered === entry) registered = null;
  };
}

/** The parent of `pathname`: a page's own registration, else {@link logicalParent}. */
export function parentFor(pathname: string): string {
  const path = normalize(pathname);
  return registered?.path === path ? registered.href : logicalParent(path);
}

/** Navigation API subset (Chrome 102+, Safari 26+): the index of the current history entry. */
interface NavigationLike {
  currentEntry: { index: number } | null;
}

/**
 * Whether going back stays inside the app. The Navigation API knows exactly: the index of the
 * current entry among this app's entries (0 on a fresh deep link, even after earlier back and
 * forward moves). Older webviews fall back to `history.length`, which can over-report after the
 * customer went back, but never under-reports.
 */
export function canGoBack(win: Pick<Window, 'history'> = window): boolean {
  const navigation = (win as { navigation?: NavigationLike }).navigation;
  const index = navigation?.currentEntry?.index;
  if (typeof index === 'number') return index > 0;
  return win.history.length > 1;
}

/**
 * The header title of the pages whose title does not depend on data, for the shells that render
 * before (loading) or instead of (not found, error) a page. `undefined` on the home page (it shows
 * the logo), `null` where the title comes from data (a category, a product).
 */
export function staticTitleFor(pathname: string, dict: Dictionary): string | null | undefined {
  if (localeFromPathname(pathname) === null) return null;
  const [, section, id] = segments(pathname);
  const t = dict.pageTitles;
  switch (section) {
    case undefined:
      return undefined;
    case 'catalog':
      return t.catalog;
    case 'search':
      return t.search;
    case 'cart':
      return t.cart;
    case 'checkout':
      return t.checkout;
    case 'orders':
      return id === undefined ? t.orders : t.order;
    case 'profile':
      return t.profile;
    case 'help':
      return t.help;
    case 'auth':
      return t.signIn;
    default:
      return null;
  }
}
