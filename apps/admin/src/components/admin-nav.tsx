'use client';

import type { UserPublic } from '@muniramarket/contracts';
import { cx } from '@muniramarket/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import {
  QUICK_NAV_IDS,
  isNavActive,
  navHref,
  navItemsFor,
  type NavGroup,
  type NavItem,
} from '@/lib/nav';
import { LanguageSwitcher } from './language-switcher';
import { LogoutButton } from './logout-button';
import { NavIcon } from './nav-icon';
import { Modal } from './ui/modal';

const ROW =
  'flex min-h-11 items-center gap-3 rounded-xl px-3 text-base transition-[background-color,transform] ' +
  'duration-150 ease-out active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';
const ROW_ON = 'bg-surface-muted font-semibold';
const ROW_OFF = 'hover:bg-surface-muted';

const GROUP_ORDER: NavGroup[] = ['main', 'catalog', 'delivery', 'system'];

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const { dict, locale } = useI18n();
  const pathname = usePathname();

  return (
    <>
      {GROUP_ORDER.map((group) => {
        const inGroup = items.filter((item) => item.group === group);
        if (inGroup.length === 0) return null;
        const heading = group === 'main' ? null : dict.nav.groups[group];
        return (
          <div key={group} className="flex flex-col gap-1">
            {heading === null ? null : (
              <p className="px-3 pt-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {heading}
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {inGroup.map((item) => {
                const active = isNavActive(item, locale, pathname);
                return (
                  <li key={item.id}>
                    <Link
                      href={navHref(locale, item)}
                      aria-current={active ? 'page' : undefined}
                      data-testid={`nav-${item.id}`}
                      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                      className={cx(ROW, active ? ROW_ON : ROW_OFF)}
                    >
                      <NavIcon id={item.id} />
                      <span className="min-w-0 break-words">{dict.nav.items[item.id]}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function Account({ user }: { user: UserPublic }) {
  const { dict } = useI18n();
  return (
    <p className="min-w-0 text-sm text-muted-foreground">
      <span className="font-medium break-words text-foreground">{user.first_name}</span> ·{' '}
      {dict.roles[user.role]}
    </p>
  );
}

/** Desktop (>= 641px): a fixed sidebar with the role's navigation, language and account. */
function Sidebar({ user, isAdmin }: { user: UserPublic; isAdmin: boolean }) {
  const { dict, locale } = useI18n();
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-r border-border bg-surface p-3 sm:flex">
      <Link
        href={`/${locale}`}
        className="flex min-h-11 items-center px-3 text-lg font-bold focus-visible:outline-2 focus-visible:outline-focus"
      >
        {dict.header.appName}
      </Link>
      <nav aria-label={dict.nav.label} className="flex flex-1 flex-col gap-2">
        <NavLinks items={navItemsFor(isAdmin)} />
      </nav>
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <Account user={user} />
        <LanguageSwitcher
          locale={locale}
          label={dict.header.language.label}
          names={dict.header.language.names}
        />
        <LogoutButton />
      </div>
    </aside>
  );
}

/** Phone (<= 640px): the "Menu" sheet holds everything the bottom bar does not. */
function MenuSheet({
  user,
  isAdmin,
  onClose,
  opener,
}: {
  user: UserPublic;
  isAdmin: boolean;
  onClose: () => void;
  opener: HTMLElement | null;
}) {
  const { dict, locale } = useI18n();
  return (
    <Modal title={dict.nav.menuTitle} onClose={onClose} returnFocusTo={opener} variant="sheet">
      <nav aria-label={dict.nav.label} className="flex flex-col gap-2">
        <NavLinks items={navItemsFor(isAdmin)} onNavigate={onClose} />
      </nav>
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {dict.nav.accountTitle}
        </p>
        <Account user={user} />
        <LanguageSwitcher
          locale={locale}
          label={dict.header.language.label}
          names={dict.header.language.names}
        />
        <LogoutButton />
      </div>
    </Modal>
  );
}

const TAB =
  'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium ' +
  'transition-transform duration-150 ease-out active:scale-[0.95] focus-visible:outline-2 ' +
  'focus-visible:-outline-offset-4 focus-visible:outline-focus';

/**
 * Phone chrome: a compact top bar (brand + menu button) and a bottom bar with the critical tasks
 * (dashboard, orders, products for admins) plus "Menu". Both respect the notch / home indicator.
 */
function MobileChrome({ user, isAdmin }: { user: UserPublic; isAdmin: boolean }) {
  const { dict, locale } = useI18n();
  const pathname = usePathname();
  // The sheet is open for the path it was opened on, so any navigation closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  const quick = navItemsFor(isAdmin).filter((item) => QUICK_NAV_IDS.includes(item.id));

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border bg-surface px-4 pt-[env(safe-area-inset-top)] sm:hidden">
        <Link
          href={`/${locale}`}
          className="flex min-h-12 min-w-0 items-center text-lg font-bold break-words focus-visible:outline-2 focus-visible:outline-focus"
        >
          {dict.header.appName}
        </Link>
      </header>

      <nav
        aria-label={dict.nav.quickLabel}
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        {quick.map((item) => {
          const active = isNavActive(item, locale, pathname);
          return (
            <Link
              key={item.id}
              href={navHref(locale, item)}
              aria-current={active ? 'page' : undefined}
              data-testid={`quick-${item.id}`}
              className={cx(TAB, active ? 'text-foreground' : 'text-muted-foreground')}
            >
              <NavIcon id={item.id} className={cx('size-6', active && 'stroke-[2.5]')} />
              <span className="max-w-full truncate">{dict.nav.items[item.id]}</span>
            </Link>
          );
        })}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="menu-button"
          onClick={(event) => {
            setOpener(event.currentTarget);
            setOpenOn(pathname);
          }}
          className={cx(TAB, 'text-muted-foreground')}
        >
          <NavIcon id="menu" className="size-6" />
          <span className="max-w-full truncate">{dict.nav.menu}</span>
        </button>
      </nav>

      {open ? (
        <MenuSheet user={user} isAdmin={isAdmin} opener={opener} onClose={() => setOpenOn(null)} />
      ) : null}
    </>
  );
}

/** The signed-in staff frame: sidebar on desktop, top bar + bottom bar on phones. */
export function StaffFrame({
  user,
  isAdmin,
  children,
}: {
  user: UserPublic;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const { dict } = useI18n();
  return (
    <div className="flex min-h-dvh sm:items-start">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-xl focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        {dict.nav.skipToContent}
      </a>
      <Sidebar user={user} isAdmin={isAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileChrome user={user} isAdmin={isAdmin} />
        <main
          id="main"
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pb-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
