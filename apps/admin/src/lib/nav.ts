import type { Locale } from '@muniramarket/contracts';

export type NavItemId =
  | 'dashboard'
  | 'orders'
  | 'products'
  | 'categories'
  | 'import'
  | 'zones'
  | 'slots'
  | 'users'
  | 'audit';

export type NavGroup = 'main' | 'catalog' | 'delivery' | 'system';

export interface NavItem {
  id: NavItemId;
  /** Path below the locale (`''` is the dashboard). */
  path: string;
  group: NavGroup;
  adminOnly: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', path: '', group: 'main', adminOnly: false },
  { id: 'orders', path: '/orders', group: 'main', adminOnly: false },
  { id: 'products', path: '/catalog/products', group: 'catalog', adminOnly: true },
  { id: 'categories', path: '/catalog/categories', group: 'catalog', adminOnly: true },
  { id: 'import', path: '/catalog/import', group: 'catalog', adminOnly: true },
  { id: 'zones', path: '/delivery/zones', group: 'delivery', adminOnly: true },
  { id: 'slots', path: '/delivery/slots', group: 'delivery', adminOnly: true },
  { id: 'users', path: '/users', group: 'system', adminOnly: true },
  { id: 'audit', path: '/audit', group: 'system', adminOnly: true },
];

/** Items the role may open: operators get the dashboard and orders, admins everything. */
export function navItemsFor(isAdmin: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => isAdmin || !item.adminOnly);
}

/** The items the phone's bottom bar shows (critical tasks); everything else is under "Menu". */
export const QUICK_NAV_IDS: readonly NavItemId[] = ['dashboard', 'orders', 'products'];

export function navHref(locale: Locale, item: NavItem): string {
  return `/${locale}${item.path}`;
}

/** The dashboard matches exactly; every other item also matches its sub-pages (`/orders/<id>`). */
export function isNavActive(item: NavItem, locale: Locale, pathname: string): boolean {
  const href = navHref(locale, item);
  if (item.path === '') return pathname === href || pathname === `${href}/`;
  return pathname === href || pathname.startsWith(`${href}/`);
}
