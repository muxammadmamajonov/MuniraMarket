import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

function locationOf(response: Response): string | null {
  const location = response.headers.get('location');
  return location === null ? null : new URL(location).pathname + new URL(location).search;
}

describe('proxy', () => {
  it('redirects / to the default locale without any signal', () => {
    const response = proxy(request('/'));
    expect(response.status).toBe(307);
    expect(locationOf(response)).toBe('/uz');
  });

  it('uses Accept-Language', () => {
    expect(locationOf(proxy(request('/', { 'accept-language': 'ru-RU,ru;q=0.9' })))).toBe('/ru');
  });

  it('prefers the locale cookie over Accept-Language', () => {
    const response = proxy(request('/', { cookie: 'locale=uz', 'accept-language': 'ru' }));
    expect(locationOf(response)).toBe('/uz');
    const other = proxy(request('/', { cookie: 'locale=ru', 'accept-language': 'uz' }));
    expect(locationOf(other)).toBe('/ru');
  });

  it('ignores an invalid cookie', () => {
    expect(locationOf(proxy(request('/', { cookie: 'locale=de', 'accept-language': 'ru' })))).toBe(
      '/ru',
    );
  });

  it('keeps path and query when adding the locale', () => {
    expect(locationOf(proxy(request('/cart?x=1&y=2', { 'accept-language': 'ru' })))).toBe(
      '/ru/cart?x=1&y=2',
    );
  });

  it('is never cached and varies on the inputs it reads', () => {
    const response = proxy(request('/'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toMatch(/Accept-Language/);
    expect(response.headers.get('vary')).toMatch(/Cookie/);
  });

  it('passes through paths that already have a locale', () => {
    for (const path of ['/uz', '/ru', '/uz/cart', '/ru/a/b']) {
      const response = proxy(request(path));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });

  it('sets a CSP with a fresh nonce on page requests', () => {
    const first = proxy(request('/uz'));
    const second = proxy(request('/uz'));
    const nonceOf = (response: Response) =>
      /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonceOf(first)).toBeDefined();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
    expect(first.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
  });

  it('forwards the same CSP on the request headers so Next can apply the nonce', () => {
    const response = proxy(request('/uz/cart'));
    const csp = response.headers.get('content-security-policy');
    expect(csp).not.toBeNull();
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('does not put a CSP on locale redirects', () => {
    expect(proxy(request('/')).headers.get('content-security-policy')).toBeNull();
  });

  it('excludes Next internals, API and files from the matcher', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test('/')).toBe(true);
    expect(pattern.test('/cart')).toBe(true);
    expect(pattern.test('/_next/static/chunk.js')).toBe(false);
    expect(pattern.test('/api/health')).toBe(false);
    expect(pattern.test('/favicon.ico')).toBe(false);
    expect(pattern.test('/robots.txt')).toBe(false);
  });
});
