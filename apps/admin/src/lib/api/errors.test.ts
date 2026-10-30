import { describe, expect, it } from 'vitest';
import { ApiRequestError, apiPath, readJson } from './errors';

describe('ApiRequestError.fromResponse', () => {
  it('reads the envelope, the current status and Retry-After', async () => {
    const error = await ApiRequestError.fromResponse(
      Response.json(
        { error: { code: 'order_status_conflict', message: 'x', current_status: 'CONFIRMED' } },
        { status: 409, headers: { 'retry-after': '4' } },
      ),
    );
    expect(error.code).toBe('order_status_conflict');
    expect(error.status).toBe(409);
    expect(error.currentStatus).toBe('CONFIRMED');
    expect(error.retryAfter).toBe(4);
    expect(error.isNetworkError).toBe(false);
  });

  it('falls back to unknown_error for a body that is not an envelope', async () => {
    const error = await ApiRequestError.fromResponse(new Response('<html>', { status: 502 }));
    expect(error.code).toBe('unknown_error');
    expect(error.status).toBe(502);
  });

  it('marks network failures', () => {
    expect(ApiRequestError.network(new TypeError('failed')).isNetworkError).toBe(true);
  });
});

describe('helpers', () => {
  it('maps a non-JSON body to invalid_response', async () => {
    await expect(readJson(new Response('nope'))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('builds same-origin API paths', () => {
    expect(apiPath('/admin/orders')).toBe('/api/v1/admin/orders');
    expect(apiPath('auth/session')).toBe('/api/v1/auth/session');
  });
});
