import { SUPPORTED_LOCALES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { formatMessage } from './format';
import { getDictionary } from './index';

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

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

  it('uses the same {placeholders} in uz and ru', () => {
    const ru = new Map(leaves(getDictionary('ru')));
    for (const [path, uzText] of leaves(getDictionary('uz'))) {
      expect(placeholders(ru.get(path) ?? ''), path).toEqual(placeholders(uzText));
    }
  });

  it('translates unit names for every product unit', () => {
    expect(Object.keys(getDictionary('uz').units).sort()).toEqual(
      Object.keys(getDictionary('ru').units).sort(),
    );
  });
});

describe('formatMessage', () => {
  it('fills placeholders and keeps unknown ones visible', () => {
    expect(formatMessage('{a} of {b}, {c}', { a: 1, b: 'two' })).toBe('1 of two, {c}');
  });
});
