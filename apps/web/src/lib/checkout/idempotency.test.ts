import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSubmissionController,
  generateIdempotencyKey,
  isValidIdempotencyKey,
} from './idempotency';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateIdempotencyKey', () => {
  it('produces keys the API accepts (16-128 of [A-Za-z0-9_-]) and never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it('falls back to getRandomValues where randomUUID is unavailable (insecure context)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        array.fill(171);
        return array;
      },
    });
    const key = generateIdempotencyKey();
    expect(key).toBe('ab'.repeat(16));
    expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it('validates the documented key shape', () => {
    expect(isValidIdempotencyKey('a'.repeat(15))).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(16))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(129))).toBe(false);
    expect(isValidIdempotencyKey(`${'a'.repeat(16)} `)).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(15) + '/')).toBe(false);
  });
});

describe('createSubmissionController', () => {
  function counting() {
    let n = 0;
    return createSubmissionController(() => `key-${String((n += 1)).padStart(16, '0')}`);
  }

  it('reuses the key while the request body is identical (retry after a network error)', () => {
    const controller = counting();
    const first = controller.keyFor('body-A');
    expect(controller.keyFor('body-A')).toBe(first);
    expect(controller.keyFor('body-A')).toBe(first);
  });

  it('issues a new key as soon as the body changes (new address or confirmed new total)', () => {
    const controller = counting();
    const first = controller.keyFor('body-A');
    const second = controller.keyFor('body-B');
    expect(second).not.toBe(first);
    // Going back to the earlier body is a different attempt as well: the old key may already
    // belong to a different order on the server.
    expect(controller.keyFor('body-A')).not.toBe(first);
  });

  it('forgets the key on reset', () => {
    const controller = counting();
    const first = controller.keyFor('body-A');
    controller.reset();
    expect(controller.keyFor('body-A')).not.toBe(first);
  });

  it('takes the lock synchronously: a second attempt in the same tick is refused', () => {
    const controller = counting();
    expect(controller.tryLock()).toBe(true);
    expect(controller.tryLock()).toBe(false);
    expect(controller.tryLock()).toBe(false);
    expect(controller.locked).toBe(true);
    controller.unlock();
    expect(controller.locked).toBe(false);
    expect(controller.tryLock()).toBe(true);
  });

  it('keeps the key across an unlock (that is what a retry is)', () => {
    const controller = counting();
    controller.tryLock();
    const first = controller.keyFor('body-A');
    controller.unlock();
    controller.tryLock();
    expect(controller.keyFor('body-A')).toBe(first);
  });
});
