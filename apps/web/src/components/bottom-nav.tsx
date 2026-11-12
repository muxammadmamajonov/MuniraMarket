'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { useOptionalCart } from '@/lib/cart';
import { BagIcon, GridIcon, HomeIcon, UserIcon } from './icons';
import { FOCUS_RING } from './ui-classes';

export type BottomNavTab = 'home' | 'catalog' | 'cart' | 'profile';

const BADGE_MAX = 99;

/** Which tab a path belongs to, or `null` for none. Exported for tests. */
export function activeTab(pathname: string): BottomNavTab | null {
  const [, section] = pathname.split('/').filter(Boolean);
  if (section === undefined) return 'home';
  if (section === 'catalog' || section === 'c' || section === 'p' || section === 'search')
    return 'catalog';
  if (section === 'cart') return 'cart';
  if (section === 'profile' || section === 'orders') return 'profile';
  return null;
}

/**
 * Focused flows where the bar would compete with the flow's own bottom control (checkout's submit
 * bar or Telegram's MainButton) or has nowhere useful to go (the sign-in callback).
 */
export function hidesBottomNav(pathname: string): boolean {
  const [, section] = pathname.split('/').filter(Boolean);
  return section === 'checkout' || section === 'auth';
}

/**
 * Mobile tab bar: Home, Catalog, Cart, Profile. Below `md` only; wide screens keep the header
 * navigation. Fixed to the bottom, padded by the bottom and side safe-area insets (home
 * indicator, Telegram fullscreen, landscape notches). While it is rendered `globals.css` sets
 * `--mm-nav-h`, which the page and the "Go to cart" bar add to their bottom padding.
 *
 * No animation on switching tabs (it is navigation, done many times a day); only the press
 * feedback (transform) and the cart badge's pop when the count changes.
 */
export function BottomNav() {
  const { dict, locale } = useI18n();
  const pathname = usePathname();
  const count = useOptionalCart()?.itemCount ?? 0;

  if (hidesBottomNav(pathname)) return null;
  const active = activeTab(pathname);
  const badge = count > BADGE_MAX ? `${String(BADGE_MAX)}+` : String(count);

  return (
    <nav
      aria-label={dict.nav.tabBar}
      data-bottom-nav
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pr-(--mm-inset-right) pb-(--mm-inset-bottom) pl-(--mm-inset-left) md:hidden"
    >
      <ul className="mx-auto grid h-14 max-w-lg grid-cols-4">
        <Tab href={`/${locale}`} current={active === 'home'} label={dict.nav.home}>
          <HomeIcon />
        </Tab>
        <Tab href={`/${locale}/catalog`} current={active === 'catalog'} label={dict.nav.catalog}>
          <GridIcon />
        </Tab>
        <Tab
          href={`/${locale}/cart`}
          current={active === 'cart'}
          label={dict.nav.cart}
          accessibleName={
            count > 0 ? formatMessage(dict.nav.cartWithCount, { count }) : dict.nav.cart
          }
          testId="bottom-nav-cart"
        >
          <span className="relative inline-flex">
            <BagIcon />
            {count > 0 ? (
              <span
                key={count}
                data-testid="bottom-nav-cart-count"
                aria-hidden="true"
                className="mm-pop absolute -top-1.5 left-3.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] leading-none font-bold whitespace-nowrap text-primary-foreground tabular-nums ring-2 ring-background"
              >
                {badge}
              </span>
            ) : null}
          </span>
        </Tab>
        <Tab href={`/${locale}/profile`} current={active === 'profile'} label={dict.nav.profile}>
          <UserIcon />
        </Tab>
      </ul>
    </nav>
  );
}

interface TabProps {
  href: string;
  current: boolean;
  label: string;
  accessibleName?: string;
  testId?: string;
  children: ReactNode;
}

function Tab({ href, current, label, accessibleName, testId, children }: TabProps) {
  const fuller = accessibleName !== undefined && accessibleName !== label;
  return (
    <li className="min-w-0">
      <Link
        href={href}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
        className={
          'group flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 ' +
          (current ? 'text-brand-ink ' : 'text-muted-foreground ') +
          FOCUS_RING
        }
      >
        {/* Press feedback on the icon only, so the label never shifts. */}
        <span className="flex transition-transform duration-150 ease-out-strong group-active:scale-[0.92] motion-reduce:transition-none">
          {children}
        </span>
        {/* The name comes from the content, never an `aria-label` that would differ from the
            visible label: a fuller name (the cart's count) replaces the short one for screen
            readers only. */}
        <span
          aria-hidden={fuller ? true : undefined}
          className={`max-w-full truncate text-[11px] leading-4 ${current ? 'font-semibold' : 'font-medium'}`}
        >
          {label}
        </span>
        {fuller ? <span className="sr-only">{accessibleName}</span> : null}
      </Link>
    </li>
  );
}
