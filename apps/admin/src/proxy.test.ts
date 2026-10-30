import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, { headers });
}

function locationOf(response: Response): string | null {
  const location = response.headers.get('location');
  return location === null ? null : new URL(location).pathname + new URL(location).search;
}

describe('admin proxy', () => {
  it('redirects / to the default locale', () => {
    const response = proxy(request('/'));
    expect(response.status).toBe(307);
    expect(locationOf(response)).toBe('/uz');
  });

  it('honours the cookie, then Accept-Language', () => {
    expect(locationOf(proxy(request('/', { cookie: 'locale=ru', 'accept-language': 'uz' })))).toBe(
      '/ru',
    );
    expect(locationOf(proxy(request('/', { 'accept-language': 'ru' })))).toBe('/ru');
  });

  it('keeps path and query, and is never cached', () => {
    const response = proxy(request('/orders?id=1', { 'accept-language': 'ru' }));
    expect(locationOf(response)).toBe('/ru/orders?id=1');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('passes through localised paths', () => {
    const response = proxy(request('/ru/orders'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('leaves robots.txt and Next internals alone', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test('/robots.txt')).toBe(false);
    expect(pattern.test('/_next/static/x.js')).toBe(false);
    expect(pattern.test('/')).toBe(true);
  });
});
