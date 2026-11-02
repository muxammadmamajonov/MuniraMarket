import { describe, expect, it } from 'vitest';
import { TONE_COUNT, initialOf, toneFor } from './placeholder';

describe('toneFor', () => {
  it('is deterministic and always inside the palette', () => {
    const keys = ['', 'a', '0b0e6a52-4c9e-4b1c-9d57-1f5f1d0a2c11', 'Демо', 'x'.repeat(500)];
    for (const key of keys) {
      const tone = toneFor(key);
      expect(tone).toBe(toneFor(key));
      expect(Number.isInteger(tone)).toBe(true);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(TONE_COUNT);
    }
  });

  it('uses more than one tint across different keys', () => {
    const tones = new Set(Array.from({ length: 40 }, (_, index) => toneFor(`category-${index}`)));
    expect(tones.size).toBeGreaterThan(3);
  });
});

describe('initialOf', () => {
  it('upper-cases the first letter, Latin or Cyrillic', () => {
    expect(initialOf('olma')).toBe('O');
    expect(initialOf('  яблоко')).toBe('Я');
  });

  it('skips leading punctuation and falls back to a dot', () => {
    expect(initialOf('“Qizil” olma')).toBe('Q');
    expect(initialOf('…')).toBe('·');
    expect(initialOf('')).toBe('·');
  });
});
