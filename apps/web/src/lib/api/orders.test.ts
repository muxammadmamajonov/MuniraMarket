import { describe, expect, it, vi } from 'vitest';
import { apiError, order, orderSummary, quote, respond } from '@/lib/checkout/test-fixtures';
import { ApiRequestError } from './errors';
import { getDeliveryZones } from './delivery';
import { cancelOrder, createOrder, getOrder, listOrders, quoteCheckout } from './orders';

function fetcher(response: Response | (() => Response)) {
  return vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () =>
    typeof response === 'function' ? response() : response,
  );
}

const REQUEST = {
  address: { district: 'yunusobod', street: 'Demo ko‘cha', house: '12' },
  recipient_name: 'Ali Valiyev',
  recipient_phone: '+998001234567',
  payment_method: 'cash_on_delivery',
  expected_total_uzs: 75000,
} as const;

describe('createOrder', () => {
  it('POSTs the body with the Idempotency-Key header and returns the order', async () => {
    const apiFetch = fetcher(respond(order(), 201));
    const result = await createOrder(apiFetch, REQUEST, 'test-idempotency-key-0001');
    expect(result.replayed).toBe(false);
    expect(result.order.number).toBe('MM-000123');
    const [path, init] = apiFetch.mock.calls[0] ?? [];
    expect(path).toBe('/orders');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'Idempotency-Key': 'test-idempotency-key-0001',
    });
    expect(JSON.parse(String(init?.body))).toEqual(REQUEST);
  });

  it('reports a replay (200 + Idempotent-Replayed: true)', async () => {
    const apiFetch = fetcher(respond(order(), 200, { 'Idempotent-Replayed': 'true' }));
    expect((await createOrder(apiFetch, REQUEST, 'test-idempotency-key-0001')).replayed).toBe(true);
  });

  it('turns every documented checkout error into an ApiRequestError with its fields', async () => {
    const cases: Array<[Response, Partial<ApiRequestError>]> = [
      [
        apiError('price_changed', 409, { total_uzs: 81000 }),
        { code: 'price_changed', totalUzs: 81000 },
      ],
      [
        apiError('insufficient_stock', 409, { product_id: 'p1', available_quantity: 2 }),
        { code: 'insufficient_stock', productId: 'p1', availableQuantity: 2 },
      ],
      [
        apiError('product_inactive', 409, { product_id: 'p1' }),
        { code: 'product_inactive', productId: 'p1' },
      ],
      [apiError('idempotency_key_conflict', 409), { code: 'idempotency_key_conflict' }],
      [
        apiError('rate_limited', 429, {}, { 'Retry-After': '9' }),
        { code: 'rate_limited', retryAfter: 9 },
      ],
      [
        apiError('validation_error', 422, {
          details: [{ loc: ['body', 'recipient_phone'], msg: 'bad' }],
        }),
        { code: 'validation_error', details: [{ loc: ['body', 'recipient_phone'], msg: 'bad' }] },
      ],
    ];
    for (const [response, expected] of cases) {
      const error = await createOrder(
        fetcher(response),
        REQUEST,
        'test-idempotency-key-0001',
      ).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject(expected);
    }
  });

  it('lets a network failure through as a network ApiRequestError', async () => {
    const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => {
      throw ApiRequestError.network();
    });
    await expect(createOrder(apiFetch, REQUEST, 'test-idempotency-key-0001')).rejects.toMatchObject(
      {
        isNetworkError: true,
      },
    );
  });
});

describe('quoteCheckout', () => {
  it('POSTs only the district', async () => {
    const apiFetch = fetcher(respond(quote()));
    await quoteCheckout(apiFetch, 'mirobod');
    const [path, init] = apiFetch.mock.calls[0] ?? [];
    expect(path).toBe('/checkout/quote');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ district: 'mirobod' });
  });
});

describe('orders reads and cancel', () => {
  it('lists with page and page_size', async () => {
    const apiFetch = fetcher(
      respond({ items: [orderSummary()], page: 2, page_size: 10, total: 11, total_pages: 2 }),
    );
    const page = await listOrders(apiFetch, { page: 2, pageSize: 10 });
    expect(apiFetch.mock.calls[0]?.[0]).toBe('/orders?page=2&page_size=10');
    expect(page.total).toBe(11);
  });

  it('lists without parameters', async () => {
    const apiFetch = fetcher(
      respond({ items: [], page: 1, page_size: 20, total: 0, total_pages: 0 }),
    );
    await listOrders(apiFetch);
    expect(apiFetch.mock.calls[0]?.[0]).toBe('/orders');
  });

  it('encodes the order id in the path', async () => {
    const apiFetch = fetcher(respond(order()));
    await getOrder(apiFetch, 'a/b c');
    expect(apiFetch.mock.calls[0]?.[0]).toBe('/orders/a%2Fb%20c');
  });

  it('cancels with the reason as JSON and surfaces order_not_cancellable with the status', async () => {
    const ok = fetcher(respond(order({ status: 'CANCELLED' })));
    await cancelOrder(ok, 'o1', 'Fikrimni o‘zgartirdim');
    const [path, init] = ok.mock.calls[0] ?? [];
    expect(path).toBe('/orders/o1/cancel');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Fikrimni o‘zgartirdim' });

    const conflict = fetcher(apiError('order_not_cancellable', 409, { current_status: 'PICKING' }));
    await expect(cancelOrder(conflict, 'o1', 'abc')).rejects.toMatchObject({
      code: 'order_not_cancellable',
      currentStatus: 'PICKING',
    });
  });

  it('maps a missing order to order_not_found', async () => {
    await expect(getOrder(fetcher(apiError('order_not_found', 404)), 'x')).rejects.toMatchObject({
      status: 404,
      code: 'order_not_found',
    });
  });
});

describe('getDeliveryZones', () => {
  it('GETs the public zone list', async () => {
    const apiFetch = fetcher(respond({ items: [], timezone: 'Asia/Tashkent' }));
    expect((await getDeliveryZones(apiFetch)).timezone).toBe('Asia/Tashkent');
    expect(apiFetch.mock.calls[0]).toEqual(['/delivery/zones', { method: 'GET' }]);
  });
});
