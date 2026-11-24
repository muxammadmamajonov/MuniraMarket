import { describe, expect, it } from 'vitest';
import { localePath, pageAlternates, siteOrigin } from './site';

describe('siteOrigin', () => {
  it('defaults to the production hostname', () => {
    expect(siteOrigin({})).toBe('https://muniramarket.uz');
    expect(siteOrigin({ SITE_ORIGIN: '  ' })).toBe('https://muniramarket.uz');
  });

  it('takes an override and strips the path and trailing slash', () => {
    expect(siteOrigin({ SITE_ORIGIN: 'https://shop.staging.example.test/' })).toBe(
      'https://shop.staging.example.test',
    );
    expect(siteOrigin({ SITE_ORIGIN: 'http://localhost:3000/x/y' })).toBe('http://localhost:3000');
  });

  it('ignores a malformed or non-http value', () => {
    expect(siteOrigin({ SITE_ORIGIN: 'not a url' })).toBe('https://muniramarket.uz');
    expect(siteOrigin({ SITE_ORIGIN: 'javascript:alert(1)' })).toBe('https://muniramarket.uz');
    expect(siteOrigin({ SITE_ORIGIN: 'ftp://example.test' })).toBe('https://muniramarket.uz');
  });
});

describe('localePath', () => {
  it('prefixes the locale; the home page has no trailing slash', () => {
    expect(localePath('uz', '/')).toBe('/uz');
    expect(localePath('ru', '/p/rice')).toBe('/ru/p/rice');
  });
});

describe('pageAlternates', () => {
  it('names its own URL as canonical and lists both languages plus x-default', () => {
    expect(pageAlternates('ru', '/catalog')).toEqual({
      canonical: '/ru/catalog',
      languages: { uz: '/uz/catalog', ru: '/ru/catalog', 'x-default': '/uz/catalog' },
    });
  });

  it('handles the home page', () => {
    expect(pageAlternates('uz', '/').canonical).toBe('/uz');
  });
});
