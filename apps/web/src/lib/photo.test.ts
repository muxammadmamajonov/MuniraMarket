import { describe, expect, it } from 'vitest';
import { photoSrcSet } from './photo';

describe('photoSrcSet', () => {
  it('pairs our own photos with their 400px file, as a path or on the storefront origin', () => {
    expect(photoSrcSet('/products/banan.webp')).toBe(
      '/products/banan-400.webp 400w, /products/banan.webp 800w',
    );
    expect(photoSrcSet('https://shop.example.uz/categories/sut.webp')).toBe(
      'https://shop.example.uz/categories/sut-400.webp 400w, https://shop.example.uz/categories/sut.webp 800w',
    );
  });

  it('leaves every other URL with a single size', () => {
    for (const src of [
      'https://cdn.example/olma.jpg',
      '/products/banan-400.webp',
      '/products/0b5c/abc.webp',
      'https://r2.example/products/1b4e28ba-2fa1-11d2-883f-0016d3cca427/abc.webp',
      'http://shop.example.uz/products/banan.webp',
      '/brand/logo.webp',
    ]) {
      expect(photoSrcSet(src)).toBeUndefined();
    }
  });
});
