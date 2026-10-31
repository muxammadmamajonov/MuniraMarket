import { describe, expect, it } from 'vitest';
import { ru } from './dictionaries/ru';
import { uz } from './dictionaries/uz';

/**
 * uz/ru parity beyond what the compiler checks (`Dictionary` already forbids missing or extra keys
 * at compile time). This walks both trees and compares, path by path: the kind of every node, the
 * length of every list, the `{placeholders}` of every string, the forms of every plural object (if
 * the admin ever gets one) and the presence (and arity) of every function. Nothing is exempt from
 * the "no empty string" rule: even the "no value" marker is a visible dash.
 */

type Entry =
  | { kind: 'string'; value: string }
  | { kind: 'function'; arity: number }
  | { kind: 'array'; length: number }
  | { kind: 'object' };

function walk(node: unknown, path: string, out: Map<string, Entry>): Map<string, Entry> {
  if (typeof node === 'string') {
    out.set(path, { kind: 'string', value: node });
  } else if (typeof node === 'function') {
    out.set(path, { kind: 'function', arity: node.length });
  } else if (Array.isArray(node)) {
    out.set(path, { kind: 'array', length: node.length });
    node.forEach((child, index) => walk(child, `${path}[${String(index)}]`, out));
  } else if (typeof node === 'object' && node !== null) {
    out.set(path, { kind: 'object' });
    for (const [key, child] of Object.entries(node)) {
      walk(child, path === '' ? key : `${path}.${key}`, out);
    }
  } else {
    // Numbers, booleans and null: nothing in a dictionary should be one.
    throw new Error(`Unsupported dictionary value at "${path}": ${String(node)}`);
  }
  return out;
}

const uzTree = walk(uz, '', new Map());
const ruTree = walk(ru, '', new Map());

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

const text = (tree: Map<string, Entry>, path: string): string => {
  const entry = tree.get(path);
  if (entry?.kind !== 'string') throw new Error(`No string at "${path}"`);
  return entry.value;
};

const PLURAL_FORMS = ['few', 'many', 'one', 'other'];

/** Paths of objects that are plural forms: exactly `one` / `few` / `many` / `other`. */
function pluralPaths(tree: Map<string, Entry>): string[] {
  const paths: string[] = [];
  for (const [path, entry] of tree) {
    if (entry.kind !== 'object' || path === '') continue;
    const prefix = `${path}.`;
    const children = [...tree.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((rest) => !rest.includes('.') && !rest.includes('['))
      .sort();
    if (
      children.length === PLURAL_FORMS.length &&
      children.every((c, i) => c === PLURAL_FORMS[i])
    ) {
      paths.push(path);
    }
  }
  return paths;
}

describe('uz and ru dictionaries: parity', () => {
  it('have identical key trees (every path, including list items)', () => {
    expect([...uzTree.keys()].sort()).toEqual([...ruTree.keys()].sort());
  });

  it('use the same kind of value at every path (string / list / object / function)', () => {
    for (const [path, entry] of uzTree) {
      expect(ruTree.get(path)?.kind, path).toBe(entry.kind);
    }
  });

  it('have lists of the same length', () => {
    for (const [path, entry] of uzTree) {
      if (entry.kind !== 'array') continue;
      const other = ruTree.get(path);
      expect(other?.kind === 'array' ? other.length : -1, path).toBe(entry.length);
    }
  });

  it('have no empty or whitespace-only strings in either language', () => {
    for (const [name, tree] of [
      ['uz', uzTree],
      ['ru', ruTree],
    ] as const) {
      for (const [path, entry] of tree) {
        if (entry.kind === 'string') expect(entry.value.trim(), `${name}.${path}`).not.toBe('');
      }
    }
  });

  it('use the same {placeholders} for every key, in both languages', () => {
    for (const [path, entry] of uzTree) {
      if (entry.kind !== 'string') continue;
      expect(placeholders(text(ruTree, path)), path).toEqual(placeholders(entry.value));
    }
  });

  it('have no unbalanced braces (a stray "{" would never be filled in)', () => {
    for (const [name, tree] of [
      ['uz', uzTree],
      ['ru', ruTree],
    ] as const) {
      for (const [path, entry] of tree) {
        if (entry.kind !== 'string') continue;
        const stripped = entry.value.replace(/\{\w+\}/g, '');
        expect(/[{}]/.test(stripped), `${name}.${path}: "${entry.value}"`).toBe(false);
      }
    }
  });

  it('have plural objects (if any) in the same places with all four forms, each filling {count}', () => {
    const uzPlurals = pluralPaths(uzTree);
    expect(pluralPaths(ruTree)).toEqual(uzPlurals);
    for (const path of uzPlurals) {
      for (const form of PLURAL_FORMS) {
        expect(placeholders(text(uzTree, `${path}.${form}`)), `uz.${path}.${form}`).toEqual([
          'count',
        ]);
        expect(placeholders(text(ruTree, `${path}.${form}`)), `ru.${path}.${form}`).toEqual([
          'count',
        ]);
      }
    }
  });

  it('have the same functions (with the same arity) in both languages, if there are any', () => {
    const functions = (tree: Map<string, Entry>) =>
      [...tree].filter(([, entry]) => entry.kind === 'function');
    expect(functions(uzTree)).toEqual(functions(ruTree));
  });

  it('keep Cyrillic out of uz (Latin), except the name of the Russian language', () => {
    for (const [path, entry] of uzTree) {
      if (entry.kind !== 'string') continue;
      if (path === 'header.language.names.ru' || path.endsWith('languageRu')) continue;
      expect(/[А-Яа-яЁё]/.test(entry.value), `uz.${path}: "${entry.value}"`).toBe(false);
    }
  });
});
