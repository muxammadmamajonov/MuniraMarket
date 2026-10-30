import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import {
  DEFAULT_RETRY_SECONDS,
  MAX_RETRY_SECONDS,
  classifyCheckoutError,
  isRetrySafe,
} from './failures';

function error(init: ConstructorParameters<typeof ApiRequestError>[0]) {
  return new ApiRequestError(init);
}

describe('classifyCheckoutError', () => {
  it('reads the new total from price_changed', () => {
    expect(
      classifyCheckoutError(
        error({ status: 409, code: 'price_changed', message: 'x', totalUzs: 81000 }),
      ),
    ).toEqual({ kind: 'price_changed', newTotal: 81000 });
  });

  it('treats a price_changed without a total as a server problem rather than guessing', () => {
    expect(
      classifyCheckoutError(error({ status: 409, code: 'price_changed', message: 'x' })),
    ).toEqual({ kind: 'server' });
  });

  it('carries the available quantity of insufficient_stock', () => {
    expect(
      classifyCheckoutError(
        error({
          status: 409,
          code: 'insufficient_stock',
          message: 'x',
          availableQuantity: 3,
          productId: 'p1',
        }),
      ),
    ).toEqual({ kind: 'insufficient_stock', available: 3 });
  });

  it.each([
    ['product_inactive', { kind: 'product_inactive' }],
    ['product_not_found', { kind: 'product_inactive' }],
    ['cart_empty', { kind: 'cart_empty' }],
    ['below_min_order', { kind: 'below_min_order' }],
    ['district_not_served', { kind: 'district_not_served' }],
    ['too_many_open_orders', { kind: 'too_many_open_orders' }],
    ['account_blocked', { kind: 'blocked' }],
    ['idempotency_key_conflict', { kind: 'key_conflict' }],
    ['session_required', { kind: 'session' }],
    ['csrf_failed', { kind: 'session' }],
    ['network_error', { kind: 'network' }],
    ['internal_error', { kind: 'server' }],
    ['service_unavailable', { kind: 'server' }],
  ] as const)('maps %s', (code, expected) => {
    expect(classifyCheckoutError(error({ status: 409, code, message: 'x' }))).toEqual(expected);
  });

  it('maps validation details onto fields', () => {
    const failure = classifyCheckoutError(
      error({
        status: 422,
        code: 'validation_error',
        message: 'x',
        details: [
          { loc: ['body', 'recipient_phone'], msg: 'bad' },
          { loc: ['body', 'expected_total_uzs'], msg: 'bad' },
        ],
      }),
    );
    expect(failure).toEqual({
      kind: 'validation',
      fields: { recipientPhone: { kind: 'invalid' } },
      unmapped: 1,
    });
  });

  it('uses Retry-After for rate limits, with a default and a cap', () => {
    expect(
      classifyCheckoutError(
        error({ status: 429, code: 'rate_limited', message: 'x', retryAfter: 12 }),
      ),
    ).toEqual({ kind: 'rate_limited', seconds: 12 });
    expect(
      classifyCheckoutError(error({ status: 429, code: 'rate_limited', message: 'x' })),
    ).toEqual({ kind: 'rate_limited', seconds: DEFAULT_RETRY_SECONDS });
    expect(
      classifyCheckoutError(
        error({ status: 429, code: 'rate_limited', message: 'x', retryAfter: 99999 }),
      ),
    ).toEqual({ kind: 'rate_limited', seconds: MAX_RETRY_SECONDS });
  });

  it('treats anything that is not an ApiRequestError as a server failure', () => {
    expect(classifyCheckoutError(new TypeError('boom'))).toEqual({ kind: 'server' });
  });
});

describe('isRetrySafe', () => {
  it('is true exactly where the same request (and key) should be sent again', () => {
    expect(isRetrySafe({ kind: 'network' })).toBe(true);
    expect(isRetrySafe({ kind: 'server' })).toBe(true);
    expect(isRetrySafe({ kind: 'rate_limited', seconds: 5 })).toBe(true);
    expect(isRetrySafe({ kind: 'price_changed', newTotal: 1 })).toBe(false);
    expect(isRetrySafe({ kind: 'insufficient_stock', available: 1 })).toBe(false);
    expect(isRetrySafe({ kind: 'key_conflict' })).toBe(false);
  });
});
