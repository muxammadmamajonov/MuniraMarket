import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_V1_PREFIX,
  PRODUCT_SORTS,
  type Cart,
  type SessionResponse,
  type HealthResponse,
  type TelegramInitDataAuthRequest,
  type TelegramInitDataAuthResponse,
  type UserPublic,
  isApiErrorEnvelope,
} from './index';

describe('api contract', () => {
  it('exposes the v1 prefix', () => {
    expect(API_V1_PREFIX).toBe('/api/v1');
  });

  it('isApiErrorEnvelope recognises the error envelope', () => {
    expect(isApiErrorEnvelope({ error: { code: 'unauthorized', message: 'Unauthorized' } })).toBe(
      true,
    );
  });

  it('isApiErrorEnvelope rejects malformed values', () => {
    expect(isApiErrorEnvelope(null)).toBe(false);
    expect(isApiErrorEnvelope('error')).toBe(false);
    expect(isApiErrorEnvelope([])).toBe(false);
    expect(isApiErrorEnvelope({})).toBe(false);
    expect(isApiErrorEnvelope({ error: 'boom' })).toBe(false);
    expect(isApiErrorEnvelope({ error: { code: 1, message: 'x' } })).toBe(false);
    expect(isApiErrorEnvelope({ error: { code: 'x' } })).toBe(false);
  });

  it('request/response shapes compile as documented', () => {
    const user: UserPublic = {
      id: '0b9d2c5e-0000-4000-8000-000000000000',
      telegram_user_id: 1,
      first_name: 'Test',
      last_name: null,
      username: null,
      language: 'uz',
      role: 'customer',
    };
    const request: TelegramInitDataAuthRequest = { init_data: 'query_id=x' };
    const response: TelegramInitDataAuthResponse = { user, csrf_token: 'csrf' };
    const health: HealthResponse = { status: 'ok', service: 'core-api', version: '0.1.0' };

    expect(request.init_data).toBe('query_id=x');
    expect(response.user.role).toBe('customer');
    expect(health.status).toBe('ok');
  });

  it('lists the error codes the API can return', () => {
    expect(API_ERROR_CODES).toContain('csrf_failed');
    expect(API_ERROR_CODES).toContain('insufficient_stock');
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it('lists the product sort keys', () => {
    expect(PRODUCT_SORTS).toEqual(['newest', 'price_asc', 'price_desc', 'name']);
  });

  it('session and cart shapes compile as documented', () => {
    const session: SessionResponse = {
      user: {
        id: 'u',
        telegram_user_id: 1,
        first_name: 'T',
        last_name: null,
        username: null,
        language: 'ru',
        role: 'customer',
      },
      csrf_token: 'x',
    };
    const cart: Cart = {
      items: [],
      item_count: 0,
      subtotal_uzs: 0,
      total_uzs: 0,
      has_issues: false,
    };
    expect(session.csrf_token).toBe('x');
    expect(cart.items).toHaveLength(0);
  });
});
