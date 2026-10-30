import { SUPPORTED_LOCALES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { getDictionary } from './index';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('admin dictionaries', () => {
  it('has a dictionary for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(getDictionary(locale).dashboard.title).toBeTruthy();
    }
  });

  it('uz and ru have identical keys (runtime mirror of the compile-time check)', () => {
    expect(keyPaths(getDictionary('uz')).sort()).toEqual(keyPaths(getDictionary('ru')).sort());
  });
});
