import { describe, expect, it } from 'vitest';
import { call, createTestApp } from '../helpers/harness.ts';

describe('gateway secret', () => {
  const app = createTestApp();

  it('accepts the gateway secret', async () => {
    const response = await call(app, 'GET', '/api/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'core-api', version: '0.1.0' });
    expect(response.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['wrong', 'wrong-secret-wrong-secret-wrong-secret-0000'],
    ['prefix', 'test-only-secret-not-for-production'],
  ])('rejects a %s secret with 401 before any work', async (_label, secret) => {
    const response = await call(app, 'GET', '/api/v1/health', { gatewaySecret: secret });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects unknown paths and other methods with the envelope', async () => {
    expect((await call(app, 'GET', '/api/v1/nope')).status).toBe(404);
    const wrong = await call(app, 'POST', '/api/v1/health');
    expect(wrong.status).toBe(405);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'method_not_allowed',
    );
  });

  it('marks session-bound prefixes no-store', async () => {
    const response = await call(app, 'GET', '/api/v1/auth/unknown');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('body limit', () => {
  const app = createTestApp();

  it('refuses a declared oversize body before any route or dependency runs', async () => {
    const response = await call(app, 'POST', '/api/v1/cart/items', {
      headers: { 'content-length': String(64 * 1024 + 1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'payload_too_large',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
