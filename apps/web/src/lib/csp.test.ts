import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, generateNonce } from './csp';
import { YANDEX_MAPS_SEARCH_ORIGIN } from './maps/config';

function directive(policy: string, name: string): string[] {
  const part = policy.split('; ').find((entry) => entry.startsWith(`${name} `));
  if (part === undefined) throw new Error(`missing directive ${name}`);
  return part.slice(name.length + 1).split(' ');
}

describe('generateNonce', () => {
  it('is base64, long enough and unique', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
  });
});

describe('buildContentSecurityPolicy', () => {
  const nonce = 'dGVzdC1ub25jZQ==';
  const production = buildContentSecurityPolicy({ nonce });

  it('puts the nonce, strict-dynamic and telegram.org (Mini App script) in script-src', () => {
    expect(directive(production, 'script-src')).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      'https://telegram.org',
    ]);
  });

  it('never allows unsafe-inline scripts or eval in production', () => {
    expect(directive(production, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(production, 'script-src')).not.toContain("'unsafe-eval'");
  });

  it('adds unsafe-eval to script-src only in development', () => {
    const dev = buildContentSecurityPolicy({ nonce, isDevelopment: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'style-src')).not.toContain("'unsafe-eval'");
    expect(dev.match(/unsafe-eval/g)).toHaveLength(1);
  });

  it('locks down the remaining directives', () => {
    expect(directive(production, 'default-src')).toEqual(["'self'"]);
    expect(directive(production, 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(production, 'img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:']);
    expect(directive(production, 'font-src')).toEqual(["'self'"]);
    expect(directive(production, 'connect-src')).toEqual(["'self'"]);
    expect(directive(production, 'frame-src')).toEqual(["'none'"]);
    expect(directive(production, 'base-uri')).toEqual(["'none'"]);
    expect(directive(production, 'form-action')).toEqual(["'self'"]);
    expect(directive(production, 'object-src')).toEqual(["'none'"]);
  });

  it('loads nothing for the browser sign-in: no Telegram OAuth host anywhere', () => {
    expect(production).not.toContain('oauth.telegram.org');
    expect(production).not.toContain('telegram-widget');
  });

  it('lets Telegram Web frame the app', () => {
    expect(directive(production, 'frame-ancestors')).toEqual([
      "'self'",
      'https://web.telegram.org',
      'https://*.telegram.org',
    ]);
  });

  it('is a single-line header value', () => {
    expect(production).not.toMatch(/[\r\n]/);
  });

  it('rejects a nonce that could break out of the header', () => {
    expect(() => buildContentSecurityPolicy({ nonce: "x'; script-src *" })).toThrow();
    expect(() => buildContentSecurityPolicy({ nonce: '' })).toThrow();
    expect(() => buildContentSecurityPolicy({ nonce: 'a\r\nb' })).toThrow();
  });

  it('allows no Yandex host unless a Maps key is configured', () => {
    expect(production).not.toContain('yandex');
    expect(directive(production, 'connect-src')).not.toContain(YANDEX_MAPS_SEARCH_ORIGIN);
    expect(production).not.toContain('worker-src');
  });

  it('with only a Maps key, allows only the official map hosts', () => {
    const withMaps = buildContentSecurityPolicy({ nonce, yandexMaps: true });
    expect(directive(withMaps, 'script-src')).toContain('https://api-maps.yandex.ru');
    expect(directive(withMaps, 'connect-src')).toEqual([
      "'self'",
      'https://api-maps.yandex.ru',
      'https://*.maps.yandex.net',
    ]);
    expect(directive(withMaps, 'connect-src')).not.toContain(YANDEX_MAPS_SEARCH_ORIGIN);
    expect(YANDEX_MAPS_SEARCH_ORIGIN).toBe('https://search-maps.yandex.ru');
    expect(directive(withMaps, 'worker-src')).toEqual(["'self'", 'blob:']);
    expect(directive(withMaps, 'frame-src')).toEqual(["'none'"]);
    expect(directive(withMaps, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('adds the geosearch host only when both Yandex products are configured', () => {
    const withGeocoder = buildContentSecurityPolicy({
      nonce,
      yandexMaps: true,
      yandexGeocoder: true,
    });
    expect(directive(withGeocoder, 'connect-src')).toContain(YANDEX_MAPS_SEARCH_ORIGIN);
  });
});
