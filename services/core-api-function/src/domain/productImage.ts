import { createHash } from 'node:crypto';

/**
 * Product image upload rules (ADR 0011; port of services/api/app/domain/product_image.py). Pure
 * functions: JPEG/PNG/WebP decided by magic bytes only, 1 byte to 5 MiB, content-addressed key
 * `products/<product uuid>/<sha256 hex>.<ext>`, server-computed SHA-256, and the original
 * filename kept only as sanitised metadata.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export type ImageRejectedCode = 'empty' | 'too_large' | 'unsupported_type';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 100;
export const EXTENSIONS: Readonly<Record<ImageType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
/** Content-addressed objects never change, so caches may keep them for a year. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const KEY_PATTERN = /^products\/[0-9a-f-]{36}\/[0-9a-f]{64}\.(jpg|png|webp)$/;

export class ImageRejectedError extends Error {
  readonly code: ImageRejectedCode;
  constructor(code: ImageRejectedCode) {
    super(code);
    this.name = 'ImageRejectedError';
    this.code = code;
  }
}

function startsWith(data: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (data.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => data[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

/** The image type from the leading magic bytes, or `null`. */
export function sniffImageType(data: Uint8Array): ImageType | null {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x89, ...ascii('PNG\r\n\x1a\n')])) return 'image/png';
  if (data.length >= 12 && startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)) {
    return 'image/webp';
  }
  return null;
}

/**
 * A display-only version of the uploaded filename: no path, no control/format/separator
 * characters (spaces kept), NFC, trimmed of spaces and dots, at most 100 characters.
 */
export function safeFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  const cleaned = [...base.normalize('NFC')]
    .filter((ch) => ch === ' ' || !/^[\p{C}\p{Z}]$/u.test(ch))
    .join('')
    .replace(/^[ .]+|[ .]+$/g, '');
  const limited = [...cleaned].slice(0, MAX_FILENAME_LENGTH).join('');
  return limited || null;
}

export interface PreparedImage {
  key: string;
  contentType: ImageType;
  size: number;
  sha256Hex: string;
  filename: string | null;
  /** The checksum in the encoding R2/S3 expect for `x-amz-checksum-sha256`. */
  sha256Base64: string;
}

/** Validate `data` and derive its storage key. Throws `ImageRejectedError`. */
export function prepareProductImage(
  productId: string,
  data: Uint8Array,
  options: { filename?: string | null } = {},
): PreparedImage {
  if (data.length === 0) throw new ImageRejectedError('empty');
  if (data.length > MAX_IMAGE_BYTES) throw new ImageRejectedError('too_large');
  const contentType = sniffImageType(data);
  if (contentType === null) throw new ImageRejectedError('unsupported_type');
  const digest = createHash('sha256').update(data).digest();
  const hex = digest.toString('hex');
  return {
    key: `products/${productId.toLowerCase()}/${hex}.${EXTENSIONS[contentType]}`,
    contentType,
    size: data.length,
    sha256Hex: hex,
    filename: safeFilename(options.filename ?? null),
    sha256Base64: digest.toString('base64'),
  };
}

export function isProductImageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** `https://<image CDN host>/<key>`: what is stored in `products.image_url`. */
export function publicImageUrl(cdnBaseUrl: string, key: string): string {
  if (!isProductImageKey(key)) throw new Error('not a product image key');
  return `${cdnBaseUrl.replace(/\/+$/, '')}/${key}`;
}
