import { describe, expect, it } from 'vitest';
import { ru } from './dictionaries/ru';
import { uz } from './dictionaries/uz';

type Tree = { [key: string]: Tree | string | Record<string, unknown> };

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');

describe('uz and ru dictionaries', () => {
  const a = new Map(flatten(uz as unknown as Tree));
  const b = new Map(flatten(ru as unknown as Tree));

  it('have the same keys', () => {
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  });

  it('have no empty strings and the same {placeholders} in both languages', () => {
    for (const [key, text] of a) {
      const other = b.get(key) ?? '';
      if (key.endsWith('noValue') || key.endsWith('noDetails')) continue;
      expect(text.trim(), key).not.toBe('');
      expect(other.trim(), key).not.toBe('');
      expect(placeholders(text), key).toBe(placeholders(other));
    }
  });

  it('keep Cyrillic out of uz (Latin), except the name of the Russian language', () => {
    for (const [key, text] of a) {
      if (key === 'header.language.names.ru' || key.endsWith('languageRu')) continue;
      expect(/[А-Яа-яЁё]/.test(text), key).toBe(false);
    }
  });
});
