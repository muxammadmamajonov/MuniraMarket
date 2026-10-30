import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  isLocale,
  negotiateLocale,
} from './locale';

describe('locale', () => {
  it('supports uz and ru', () => {
    expect(SUPPORTED_LOCALES).toEqual(['uz', 'ru']);
  });

  it('defaults to uz and the default is supported', () => {
    expect(DEFAULT_LOCALE).toBe('uz');
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('isLocale accepts supported locales only', () => {
    expect(isLocale('uz')).toBe(true);
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('en')).toBe(false);
    expect(isLocale('UZ')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
});

describe('negotiateLocale', () => {
  it('uses the cookie name "locale"', () => {
    expect(LOCALE_COOKIE).toBe('locale');
  });

  it('prefers a valid cookie over Accept-Language', () => {
    expect(negotiateLocale({ cookie: 'ru', acceptLanguage: 'uz' })).toBe('ru');
    expect(negotiateLocale({ cookie: 'uz', acceptLanguage: 'ru' })).toBe('uz');
  });

  it('ignores an invalid cookie', () => {
    expect(negotiateLocale({ cookie: 'en', acceptLanguage: 'ru' })).toBe('ru');
    expect(negotiateLocale({ cookie: '', acceptLanguage: null })).toBe('uz');
  });

  it('falls back to the default without any signal', () => {
    expect(negotiateLocale({})).toBe('uz');
    expect(negotiateLocale({ acceptLanguage: '' })).toBe('uz');
  });

  it('matches by primary subtag', () => {
    expect(negotiateLocale({ acceptLanguage: 'ru-RU,ru;q=0.9' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'UZ-latn-UZ' })).toBe('uz');
  });

  it('honours q-values and order', () => {
    expect(negotiateLocale({ acceptLanguage: 'en-US,ru;q=0.8,uz;q=0.4' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'uz;q=0.4,ru;q=0.8' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'ru,uz' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'uz,ru' })).toBe('uz');
  });

  it('skips unsupported languages and q=0', () => {
    expect(negotiateLocale({ acceptLanguage: 'en,de;q=0.5' })).toBe('uz');
    expect(negotiateLocale({ acceptLanguage: 'ru;q=0, uz;q=0.1' })).toBe('uz');
    expect(negotiateLocale({ acceptLanguage: 'ru;q=abc, uz;q=0.1' })).toBe('uz');
    expect(negotiateLocale({ acceptLanguage: '*' })).toBe('uz');
  });
});
