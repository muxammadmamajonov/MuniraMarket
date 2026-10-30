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

describe('admin proxy: locale routing', () => {
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
    expect(response.headers.get('vary')).toMatch(/Accept-Language/);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('passes through localised paths', () => {
    for (const path of ['/uz', '/ru/orders', '/ru/auth/telegram']) {
      const response = proxy(request(path));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('leaves robots.txt, Next internals and the API proxy alone', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test('/robots.txt')).toBe(false);
    expect(pattern.test('/_next/static/x.js')).toBe(false);
    expect(pattern.test('/api/v1/admin/orders')).toBe(false);
    expect(pattern.test('/')).toBe(true);
    expect(pattern.test('/ru/orders/abc')).toBe(true);
  });
});

describe('admin proxy: headers on pages', () => {
  const nonceOf = (response: Response) =>
    /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];

  it('sets a CSP with a fresh nonce, the Telegram widget allowances and frame-ancestors none', () => {
    const first = proxy(request('/uz'));
    const second = proxy(request('/uz'));
    expect(nonceOf(first)).toBeDefined();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    const csp = first.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain('frame-src https://oauth.telegram.org');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('forwards the same CSP on the request headers so Next can apply the nonce', () => {
    const response = proxy(request('/uz/orders/x'));
    const csp = response.headers.get('content-security-policy');
    expect(csp).not.toBeNull();
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('forbids shared caching of admin pages', () => {
    expect(proxy(request('/ru')).headers.get('cache-control')).toBe('private, no-store');
  });
});
