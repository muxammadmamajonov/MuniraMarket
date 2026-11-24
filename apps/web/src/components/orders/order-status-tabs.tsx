'use client';

import { ORDER_STATUS_GROUPS, type OrderStatusGroup } from '@muniramarket/contracts';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useI18n } from '@/i18n/context';
import { ordersHref } from '@/lib/orders/status-group';
import { useSession } from '@/lib/session';
import { FOCUS_RING } from '../ui-classes';

/**
 * The status filter of "My orders": a horizontally scrolling segmented control whose state lives
 * in the URL (`?status=`), so back/forward, reload and shared links keep the tab. Each segment is
 * a link (`aria-current="page"` on the active one): switching is navigation, done often, so it is
 * not animated; only the press gives feedback. The active segment is scrolled into view.
 */
export function OrderStatusTabs({ active }: { active: OrderStatusGroup }) {
  const { dict, locale } = useI18n();
  const t = dict.orderTabs;
  const activeRef = useRef<HTMLAnchorElement>(null);
  const { status } = useSession();

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [active]);

  // Signed out there is nothing to filter: the page shows the sign-in prompt alone.
  if (status === 'anonymous') return null;

  return (
    <nav aria-label={t.label} className="-mx-4 sm:mx-0">
      <ul
        data-testid="order-tabs"
        className="flex snap-x gap-2 overflow-x-auto overscroll-x-contain px-4 py-0.5 [scrollbar-width:none] sm:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {ORDER_STATUS_GROUPS.map((group) => {
          const current = group === active;
          return (
            <li key={group} className="shrink-0 snap-start">
              <Link
                ref={current ? activeRef : undefined}
                href={ordersHref(locale, group)}
                replace
                scroll={false}
                aria-current={current ? 'page' : undefined}
                data-testid={`order-tab-${group}`}
                className={
                  `inline-flex min-h-11 items-center rounded-full px-4 text-[15px] font-semibold whitespace-nowrap ` +
                  `transition-[transform,background-color,color] duration-150 ease-out-strong active:scale-[0.97] motion-reduce:transition-none ${FOCUS_RING} ` +
                  (current
                    ? 'bg-foreground text-background'
                    : 'bg-surface text-foreground hover:bg-surface-muted')
                }
              >
                {t[group]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
