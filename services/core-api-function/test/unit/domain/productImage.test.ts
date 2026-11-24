import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateImageUrl } from '../../../src/domain/imageUrl.ts';
import {
  ImageRejectedError,
  isProductImageKey,
  MAX_IMAGE_BYTES,
  prepareProductImage,
  publicImageUrl,
  safeFilename,
  sniffImageType,
} from '../../../src/domain/productImage.ts';

const PRODUCT = '0b8f6a52-7c1e-4e0e-9d0e-5c8d2f1b7a10';
const bytes = (...parts: Array<number[] | string>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : part)),
  );
const zeros = (n: number) => new Array<number>(n).fill(0);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], zeros(64));
const PNG = bytes([0x89], 'PNG\r\n\x1a\n', zeros(64));
const WEBP = bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ', zeros(64));

const rejectedCode = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ImageRejectedError ? error.code : 'other';
  }
};

describe('product images', () => {
  it.each([
    [JPEG, 'image/jpeg'],
    [PNG, 'image/png'],
    [WEBP, 'image/webp'],
  ])('sniffs magic bytes', (data, expected) => {
    expect(sniffImageType(data)).toBe(expected);
  });

  it.each([
    "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    '<!doctype html><html>',
    `GIF89a${'\x00'.repeat(10)}`,
    'RIFF\x00\x00\x00\x00WAVE',
    '%PDF-1.7',
  ])('refuses other content whatever its name (%#)', (content) => {
    expect(
      rejectedCode(() => prepareProductImage(PRODUCT, bytes(content), { filename: 'photo.jpg' })),
    ).toBe('unsupported_type');
  });

  it('size limits', () => {
    expect(rejectedCode(() => prepareProductImage(PRODUCT, new Uint8Array()))).toBe('empty');
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1);
    tooBig.set(JPEG);
    expect(rejectedCode(() => prepareProductImage(PRODUCT, tooBig))).toBe('too_large');
    const exact = new Uint8Array(MAX_IMAGE_BYTES);
    exact.set(JPEG);
    expect(prepareProductImage(PRODUCT, exact).size).toBe(MAX_IMAGE_BYTES);
  });

  it('key is content-addressed and free of user text', () => {
    const prepared = prepareProductImage(PRODUCT, PNG, { filename: '../../etc/passwd.png' });
    const digest = createHash('sha256').update(PNG).digest('hex');
    expect(prepared.key).toBe(`products/${PRODUCT}/${digest}.png`);
    expect(prepared.sha256Hex).toBe(digest);
    expect(isProductImageKey(prepared.key)).toBe(true);
    expect(prepared.key).not.toContain('passwd');
    expect(prepareProductImage(PRODUCT, PNG).key).toBe(prepared.key);
    expect(prepareProductImage(PRODUCT, WEBP).sha256Base64).toBe(
      createHash('sha256').update(WEBP).digest('base64'),
    );
  });

  it.each([
    ['photo.jpg', 'photo.jpg'],
    ['C:\\Users\\me\\Desktop\\non.jpg', 'non.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['evil\u202egpj.exe', 'evilgpj.exe'],
    ['zero\u200bwidth.png', 'zerowidth.png'],
    ['tab\tand\nnewline.png', 'tabandnewline.png'],
    ['Нон (2).jpg', 'Нон (2).jpg'],
    ['...', null],
    ['', null],
    [null, null],
    ['a'.repeat(150), 'a'.repeat(100)],
  ])('safeFilename(%j)', (raw, expected) => {
    expect(safeFilename(raw)).toBe(expected);
  });

  it.each([
    `products/${PRODUCT}/${'a'.repeat(64)}.gif`,
    `products/${PRODUCT}/${'a'.repeat(63)}.jpg`,
    `products/../${'a'.repeat(64)}.jpg`,
    `tmp/${PRODUCT}/${'a'.repeat(64)}.jpg`,
    `products/${PRODUCT}/${'A'.repeat(64)}.jpg`,
  ])('foreign keys are not product image keys (%#)', (key) => {
    expect(isProductImageKey(key)).toBe(false);
  });

  it('public URL passes the image URL validation', () => {
    const prepared = prepareProductImage(PRODUCT, JPEG);
    const url = publicImageUrl('https://images.example.test/', prepared.key);
    expect(url).toBe(`https://images.example.test/${prepared.key}`);
    expect(validateImageUrl(url)).toBe(url);
    expect(() => publicImageUrl('https://images.example.test', 'products/../x')).toThrow(
      'not a product image key',
    );
  });
});
