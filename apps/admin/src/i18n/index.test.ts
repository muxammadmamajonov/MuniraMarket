import { SUPPORTED_LOCALES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { formatMessage } from './format';
import { getDictionary } from './index';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(leaves);
}

describe('admin dictionaries', () => {
  it('has a dictionary for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(getDictionary(locale).orders.title).toBeTruthy();
    }
  });

  it('uz and ru have identical keys (runtime mirror of the compile-time check)', () => {
    expect(keyPaths(getDictionary('uz')).sort()).toEqual(keyPaths(getDictionary('ru')).sort());
  });

  it('has no empty strings, and uz and ru use the same placeholders', () => {
    const uz = leaves(getDictionary('uz'));
    const ru = leaves(getDictionary('ru'));
    expect(uz.every((text) => text.trim() !== '')).toBe(true);
    expect(ru.every((text) => text.trim() !== '')).toBe(true);
    const placeholders = (texts: string[]) =>
      texts.map((text) => (text.match(/\{\w+\}/g) ?? []).sort().join(','));
    expect(placeholders(uz)).toEqual(placeholders(ru));
  });
});

describe('formatMessage', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(formatMessage('Order {number} is {status} {x}', { number: 'A1', status: 'new' })).toBe(
      'Order A1 is new {x}',
    );
  });
});
