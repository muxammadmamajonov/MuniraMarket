import { describe, expect, it } from 'vitest';
import { hasInvisibleCharacters, pyLen, pyStrip } from '../../../src/domain/text.ts';

describe('hasInvisibleCharacters', () => {
  it.each([
    'Olma\u202egnp.exe',
    'Ol\u200bma',
    '\ufeffOlma',
    'Olma\u2066x\u2069',
    'Olma\u2028nok',
    'Olma\u3164',
    'a\u034fb',
    'Shirin\u00adolma',
    'lone \ud800 surrogate',
  ])('refuses %j in names', (value) => {
    expect(hasInvisibleCharacters(value)).toBe(true);
  });

  it('allows ordinary text, emoji and Cyrillic', () => {
    expect(hasInvisibleCharacters("O'zbek olma — 1 kg 🍎 Демо")).toBe(false);
  });

  it('multiline text accepts line separators but not format characters', () => {
    expect(hasInvisibleCharacters('a\u2028b', { multiline: true })).toBe(false);
    expect(hasInvisibleCharacters('a\u2028b')).toBe(true);
    expect(hasInvisibleCharacters('Shirin\n\u202eolma', { multiline: true })).toBe(true);
  });
});

describe('python string helpers', () => {
  it('pyStrip strips what str.strip() strips', () => {
    expect(pyStrip(' \t\x1cabc\x85\u3000 ')).toBe('abc');
    expect(pyStrip('\ufeffabc')).toBe('\ufeffabc');
  });

  it('pyLen counts code points', () => {
    expect(pyLen('🍎a')).toBe(2);
  });
});
