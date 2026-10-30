import { SUPPORTED_LOCALES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { getDictionary } from './index';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('dictionaries', () => {
  it('has a dictionary for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(getDictionary(locale).home.title).toBeTruthy();
    }
  });

  it('uz and ru have identical keys (runtime mirror of the compile-time check)', () => {
    expect(keyPaths(getDictionary('uz')).sort()).toEqual(keyPaths(getDictionary('ru')).sort());
  });

  it('has no empty strings', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const path of keyPaths(getDictionary(locale))) {
        const value = path
          .split('.')
          .reduce<unknown>(
            (acc, key) => (acc as Record<string, unknown>)[key],
            getDictionary(locale),
          );
        expect(value, `${locale}.${path}`).not.toBe('');
      }
    }
  });
});
