import { afterEach, describe, expect, it } from 'vitest';
import {
  localeFromPathname,
  persistLocale,
  serializeLocaleCookie,
  switchLocalePath,
} from './switch-locale';

describe('switchLocalePath', () => {
  it('replaces the locale segment', () => {
    expect(switchLocalePath('/uz', 'ru')).toBe('/ru');
    expect(switchLocalePath('/uz/', 'ru')).toBe('/ru/');
    expect(switchLocalePath('/ru/cart/items', 'uz')).toBe('/uz/cart/items');
  });

  it('prefixes a path without a locale', () => {
    expect(switchLocalePath('/', 'ru')).toBe('/ru');
    expect(switchLocalePath('/cart', 'ru')).toBe('/ru/cart');
  });

  it('does not treat a longer first segment as a locale', () => {
    expect(switchLocalePath('/uzbek', 'ru')).toBe('/ru/uzbek');
  });
});

describe('localeFromPathname', () => {
  it('reads the first segment', () => {
    expect(localeFromPathname('/uz')).toBe('uz');
    expect(localeFromPathname('/ru/x')).toBe('ru');
    expect(localeFromPathname('/')).toBeNull();
    expect(localeFromPathname('/en')).toBeNull();
    expect(localeFromPathname('/uzbek')).toBeNull();
  });
});

describe('locale cookie', () => {
  afterEach(() => {
    document.cookie = 'locale=; Path=/; Max-Age=0';
  });

  it('serialises with Path, one-year Max-Age and SameSite=Lax', () => {
    expect(serializeLocaleCookie('ru', false)).toBe(
      'locale=ru; Path=/; Max-Age=31536000; SameSite=Lax',
    );
  });

  it('adds Secure over https', () => {
    expect(serializeLocaleCookie('uz', true)).toMatch(/; Secure$/);
  });

  it('persistLocale writes the cookie (not localStorage)', () => {
    persistLocale('ru');
    expect(document.cookie).toContain('locale=ru');
    expect(window.localStorage.length).toBe(0);
  });
});
