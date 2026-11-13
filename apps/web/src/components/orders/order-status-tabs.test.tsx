import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
const session = vi.hoisted(() => ({ status: 'authenticated' as 'authenticated' | 'anonymous' }));
vi.mock('@/lib/session', () => ({ useSession: () => session }));

import { ordersHref, parseStatusGroup } from '@/lib/orders/status-group';
import { OrderStatusTabs } from './order-status-tabs';

describe('order status tabs', () => {
  it('reads ?status= safely', () => {
    expect(parseStatusGroup(undefined)).toBe('all');
    expect(parseStatusGroup('active')).toBe('active');
    expect(parseStatusGroup(['done', 'active'])).toBe('done');
    expect(parseStatusGroup('NEW')).toBe('all');
  });

  it('builds the URL state', () => {
    expect(ordersHref('uz', 'all')).toBe('/uz/orders');
    expect(ordersHref('uz', 'delivering')).toBe('/uz/orders?status=delivering');
    expect(ordersHref('ru', 'done', 2)).toBe('/ru/orders?status=done&page=2');
  });

  it('renders the five segments in order with the active one current', () => {
    render(
      <LocaleProvider locale="uz">
        <OrderStatusTabs active="delivering" />
      </LocaleProvider>,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Barchasi',
      'Faol',
      'Yetkazilmoqda',
      'Yakunlangan',
      'Bekor qilingan',
    ]);
    expect(screen.getByRole('link', { name: 'Yetkazilmoqda' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Barchasi' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('navigation', { name: 'Holat bo‘yicha saralash' })).toBeInTheDocument();
  });

  it('is hidden when signed out', () => {
    session.status = 'anonymous';
    render(
      <LocaleProvider locale="uz">
        <OrderStatusTabs active="all" />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('navigation')).toBeNull();
    session.status = 'authenticated';
  });
});
