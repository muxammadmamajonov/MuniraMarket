import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSubmissionController,
  generateIdempotencyKey,
  isValidIdempotencyKey,
  NO_ATTEMPT_STORE,
  type AttemptStore,
} from './idempotency';
import { hashBody, type PendingAttempt } from './pending-attempt';

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
  let n = 0;
  const nextKey = () => `key-${String((n += 1)).padStart(16, '0')}`;
  function counting() {
    return createSubmissionController({ generate: nextKey, store: NO_ATTEMPT_STORE });
  }
  const ALI = { owner: 'user-ali', totalUzs: 75000 };

  it('reuses the key while the request body is identical (retry after a network error)', () => {
    const controller = counting();
    const first = controller.keyFor('body-A', ALI);
    expect(controller.keyFor('body-A', ALI)).toBe(first);
    expect(controller.keyFor('body-A', ALI)).toBe(first);
  });

  it('issues a new key as soon as the body changes (new address or confirmed new total)', () => {
    const controller = counting();
    const first = controller.keyFor('body-A', ALI);
    const second = controller.keyFor('body-B', ALI);
    expect(second).not.toBe(first);
    // Going back to the earlier body is a different attempt as well: the old key may already
    // belong to a different order on the server.
    expect(controller.keyFor('body-A', ALI)).not.toBe(first);
  });

  it('forgets the key on reset', () => {
    const controller = counting();
    const first = controller.keyFor('body-A', ALI);
    controller.reset();
    expect(controller.keyFor('body-A', ALI)).not.toBe(first);
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
    const first = controller.keyFor('body-A', ALI);
    controller.unlock();
    controller.tryLock();
    expect(controller.keyFor('body-A', ALI)).toBe(first);
  });
});

describe('createSubmissionController: the attempt outlives the page', () => {
  /** A store shared by "page loads", like this tab's sessionStorage. */
  function memoryStore() {
    let saved: PendingAttempt | null = null;
    const store: AttemptStore & { readonly saved: PendingAttempt | null } = {
      read: () => saved,
      save: (attempt) => {
        saved = attempt;
      },
      clear: () => {
        saved = null;
      },
      get saved() {
        return saved;
      },
    };
    return store;
  }
  let n = 0;
  const generate = () => `key-${String((n += 1)).padStart(16, '0')}`;
  const ALI = { owner: 'user-ali', totalUzs: 75000 };

  it('reuses the stored key after a reload when the body is unchanged', () => {
    const store = memoryStore();
    const before = createSubmissionController({ generate, store, now: () => 1_000 });
    const key = before.keyFor('body-A', ALI);
    expect(store.saved).toEqual({
      key,
      bodyHash: hashBody('body-A'),
      owner: 'user-ali',
      totalUzs: 75000,
      createdAt: 1_000,
    });

    const after = createSubmissionController({ generate, store, now: () => 5_000 });
    expect(after.keyFor('body-A', ALI)).toBe(key);
    // Reusing does not restart the attempt's clock.
    expect(store.saved?.createdAt).toBe(1_000);
  });

  it('never stores the request body itself', () => {
    const store = memoryStore();
    const body = JSON.stringify({ recipient_phone: '+998001234567', street: 'Demo ko‘cha' });
    createSubmissionController({ generate, store }).keyFor(body, ALI);
    expect(JSON.stringify(store.saved)).not.toContain('998001234567');
    expect(JSON.stringify(store.saved)).not.toContain('Demo');
  });

  it('issues and stores a new key when the body changed across the reload', () => {
    const store = memoryStore();
    const key = createSubmissionController({ generate, store }).keyFor('body-A', ALI);
    const after = createSubmissionController({ generate, store });
    const next = after.keyFor('body-B', ALI);
    expect(next).not.toBe(key);
    expect(store.saved?.key).toBe(next);
    expect(store.saved?.bodyHash).toBe(hashBody('body-B'));
  });

  it('does not hand another account the stored key', () => {
    const store = memoryStore();
    const key = createSubmissionController({ generate, store }).keyFor('body-A', ALI);
    const other = createSubmissionController({ generate, store });
    expect(other.keyFor('body-A', { owner: 'user-bob', totalUzs: 75000 })).not.toBe(key);
  });

  it('clears the stored attempt on reset (order placed, or key conflict)', () => {
    const store = memoryStore();
    const controller = createSubmissionController({ generate, store });
    const key = controller.keyFor('body-A', ALI);
    controller.reset();
    expect(store.saved).toBeNull();
    expect(createSubmissionController({ generate, store }).keyFor('body-A', ALI)).not.toBe(key);
  });

  it('keeps working in memory when storage is unavailable', () => {
    const broken: AttemptStore = {
      read: () => null,
      save: () => undefined,
      clear: () => undefined,
    };
    const controller = createSubmissionController({ generate, store: broken });
    const key = controller.keyFor('body-A', ALI);
    expect(controller.keyFor('body-A', ALI)).toBe(key);
  });
});
