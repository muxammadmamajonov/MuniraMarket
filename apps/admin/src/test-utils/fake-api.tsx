import type {
  AdminOrderDetail,
  Locale,
  OrderPage,
  OrderSummary,
  SessionResponse,
  UserPublic,
  UserRole,
} from '@muniramarket/contracts';
import { formatUZS } from '@muniramarket/ui';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { AdminShell } from '@/components/admin-shell';
import { LocaleProvider } from '@/i18n/context';
import { SessionProvider } from '@/lib/session';

/** Everything below is synthetic: no real names, phones or addresses. */

export interface FakeCall {
  method: string;
  /** Path and query below the origin, e.g. `/api/v1/admin/orders?page=1`. */
  path: string;
  headers: Headers;
  body: unknown;
}

export type FakeHandler = (call: FakeCall) => Response | Promise<Response> | undefined;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export function apiError(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message: 'test', ...extra } }, { status });
}

export function userWithRole(role: UserRole): UserPublic {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    telegram_user_id: 100,
    first_name: 'Test',
    last_name: null,
    username: null,
    language: 'uz',
    role,
  };
}

export function sessionFor(role: UserRole, csrfToken = 'csrf-1'): SessionResponse {
  return { user: userWithRole(role), csrf_token: csrfToken };
}

/**
 * Replaces `fetch`. Handlers are tried in order; the first to return a Response wins. Anything
 * unhandled fails the request loudly, so a test notices an unexpected call.
 */
export function installFakeApi(...handlers: FakeHandler[]) {
  const calls: FakeCall[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'http://admin.test');
    const raw = init?.body;
    const call: FakeCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    };
    calls.push(call);
    for (const handler of handlers) {
      const response = await handler(call);
      if (response !== undefined) return response;
    }
    throw new Error(`unexpected request ${call.method} ${call.path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    /** Calls whose path starts with `prefix`. */
    to: (prefix: string) => calls.filter((call) => call.path.startsWith(prefix)),
  };
}

export function sessionHandler(role: UserRole, csrfToken = 'csrf-1'): FakeHandler {
  return (call) =>
    call.method === 'GET' && call.path === '/api/v1/auth/session'
      ? json(sessionFor(role, csrfToken))
      : undefined;
}

export const ORDER_ID = '0b1f4c7e-2d4a-4f3b-9a53-6f0f1b8a7c11';

export function orderSummary(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: ORDER_ID,
    number: 'MM-000123',
    status: 'NEW',
    item_count: 3,
    total_uzs: 125000,
    created_at: '2026-10-31T09:05:00Z',
    ...overrides,
  };
}

export function orderPage(items: OrderSummary[], overrides: Partial<OrderPage> = {}): OrderPage {
  return {
    items,
    page: 1,
    page_size: 20,
    total: items.length,
    total_pages: items.length === 0 ? 0 : 1,
    ...overrides,
  };
}

export function orderDetail(overrides: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  return {
    id: ORDER_ID,
    number: 'MM-000123',
    status: 'NEW',
    item_count: 2,
    subtotal_uzs: 110000,
    delivery_fee_uzs: 15000,
    total_uzs: 125000,
    payment_method: 'cash_on_delivery',
    recipient_name: 'Test Recipient',
    recipient_phone: '+998 00 000 00 00',
    address: {
      district: 'chilonzor',
      district_name_uz: 'Chilonzor',
      district_name_ru: 'Чиланзар',
      street: 'Test street',
      house: '12',
      apartment: '34',
      entrance: '2',
      floor: '5',
      landmark: 'Near the test park',
    },
    comment: 'Call before arriving',
    cancel_reason: null,
    can_cancel: true,
    created_at: '2026-10-31T09:05:00Z',
    updated_at: '2026-10-31T09:05:00Z',
    items: [
      {
        product_id: null,
        sku: 'TEST-APPLE',
        name_uz: 'Test olma',
        name_ru: 'Тестовое яблоко',
        unit: 'kg',
        quantity: 2,
        unit_price_uzs: 30000,
        line_total_uzs: 60000,
      },
      {
        product_id: null,
        sku: 'TEST-BREAD',
        name_uz: 'Test non',
        name_ru: 'Тестовый хлеб',
        unit: 'piece',
        quantity: 5,
        unit_price_uzs: 10000,
        line_total_uzs: 50000,
      },
    ],
    history: [{ status: 'NEW', at: '2026-10-31T09:05:00Z' }],
    history_detail: [
      {
        from_status: null,
        status: 'NEW',
        actor_role: 'customer',
        reason: null,
        at: '2026-10-31T09:05:00Z',
      },
    ],
    allowed_transitions: ['CONFIRMED', 'CANCELLED'],
    ...overrides,
  };
}

/** Providers plus the gate, as the real app renders them. */
export function renderAdmin(ui: ReactElement, locale: Locale = 'ru') {
  return render(
    <LocaleProvider locale={locale}>
      <SessionProvider>
        <AdminShell>{ui}</AdminShell>
      </SessionProvider>
    </LocaleProvider>,
  );
}

/** Providers only (no gate). */
export function renderWithProviders(ui: ReactElement, locale: Locale = 'ru') {
  return render(
    <LocaleProvider locale={locale}>
      <SessionProvider>{ui}</SessionProvider>
    </LocaleProvider>,
  );
}

/**
 * Text matcher for a formatted amount. `formatUZS` joins with NBSP, which Testing Library's default
 * normalizer turns into plain spaces on the DOM side only.
 */
export function money(amount: number, locale: Locale): (content: string) => boolean {
  const expected = formatUZS(amount, locale).replace(/\s+/g, ' ');
  return (content) => content === expected;
}

/** A promise settled from the outside, for holding a request open. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
