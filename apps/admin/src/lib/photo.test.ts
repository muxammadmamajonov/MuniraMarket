import { describe, expect, it } from 'vitest';
import { ownPhotoPath } from './photo';

describe('ownPhotoPath', () => {
  it('maps the store photos (bare path or storefront URL) to the same-origin 400px file', () => {
    expect(ownPhotoPath('/products/anor.webp')).toBe('/products/anor-400.webp');
    expect(ownPhotoPath('https://muniramarket.uz/categories/non.webp')).toBe(
      '/categories/non-400.webp',
    );
    expect(ownPhotoPath('/products/anor-400.webp')).toBe('/products/anor-400.webp');
  });

  it('returns the 800px file for the form preview', () => {
    expect(ownPhotoPath('/products/anor.webp', 'full')).toBe('/products/anor.webp');
  });

  it('never hands out anything else (the CSP would block it)', () => {
    for (const src of [
      null,
      undefined,
      '',
      'https://cdn.example.com/apple.jpg',
      '/products/../secret.webp',
      '/products/Anor.webp',
      '/uploads/anor.webp',
      'http://muniramarket.uz/products/anor.webp',
    ]) {
      expect(ownPhotoPath(src)).toBeNull();
    }
  });
});
