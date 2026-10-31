import type { OrderSummary } from '@muniramarket/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubmissionController } from './idempotency';
import {
  CLOCK_SKEW_MS,
  PENDING_ATTEMPT_MAX_AGE_MS,
  clearPendingAttempt,
  findOrderForAttempt,
  hashBody,
  readPendingAttempt,
  savePendingAttempt,
  type PendingAttempt,
} from './pending-attempt';

const STORAGE_KEY = 'mm.checkoutAttempt';
const T0 = Date.parse('2026-10-31T10:00:00Z');
/** Built at runtime: a literal UUID next to `key:` reads like a secret to the secret scanner. */
const ATTEMPT_KEY = crypto.randomUUID();

function attempt(overrides: Partial<PendingAttempt> = {}): PendingAttempt {
  return {
    key: ATTEMPT_KEY,
    bodyHash: hashBody('body-A'),
    owner: 'user-ali',
    totalUzs: 75000,
    createdAt: T0,
    ...overrides,
  };
}

function summary(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: '3f2a9c1e-5b7d-4e8a-9c3b-1a2b3c4d5e6f',
    number: 'MM-000123',
    status: 'NEW',
    created_at: new Date(T0 + 5_000).toISOString(),
    item_count: 4,
    total_uzs: 75000,
    ...overrides,
  } as OrderSummary;
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('hashBody', () => {
  it('is stable, 16 hex characters, and differs for a one-character change', () => {
    expect(hashBody('body-A')).toBe(hashBody('body-A'));
    expect(hashBody('body-A')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashBody('body-A')).not.toBe(hashBody('body-B'));
    expect(hashBody('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles non-Latin text and long bodies', () => {
    const cyrillic = JSON.stringify({ street: 'Улица Амира Темура'.repeat(50) });
    expect(hashBody(cyrillic)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashBody(cyrillic)).not.toBe(hashBody(cyrillic.replace('Т', 'т')));
  });
});

describe('sessionStorage round trip', () => {
  it('reads back what was saved', () => {
    savePendingAttempt(attempt());
    expect(readPendingAttempt(T0 + 1_000)).toEqual(attempt());
  });

  it('expires after 24 hours and removes the entry', () => {
    savePendingAttempt(attempt());
    expect(readPendingAttempt(T0 + PENDING_ATTEMPT_MAX_AGE_MS)).not.toBeNull();
    expect(readPendingAttempt(T0 + PENDING_ATTEMPT_MAX_AGE_MS + 1)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('drops an attempt from the future (the clock went back)', () => {
    savePendingAttempt(attempt());
    expect(readPendingAttempt(T0 - 1)).toBeNull();
  });

  it('ignores and removes malformed or tampered entries', () => {
    for (const raw of [
      'not json',
      'null',
      JSON.stringify({ ...attempt(), key: 'short' }),
      JSON.stringify({ ...attempt(), key: 'has spaces in it, sixteen+' }),
      JSON.stringify({ ...attempt(), bodyHash: 'XYZ' }),
      JSON.stringify({ ...attempt(), owner: '' }),
      JSON.stringify({ ...attempt(), totalUzs: '75000' }),
      JSON.stringify({ ...attempt(), createdAt: null }),
    ]) {
      window.sessionStorage.setItem(STORAGE_KEY, raw);
      expect(readPendingAttempt(T0)).toBeNull();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    }
  });

  it('clears', () => {
    savePendingAttempt(attempt());
    clearPendingAttempt();
    expect(readPendingAttempt(T0)).toBeNull();
  });

  it('survives storage that throws (privacy mode, a refusing WebView)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => savePendingAttempt(attempt())).not.toThrow();
    expect(readPendingAttempt(T0)).toBeNull();
    expect(() => clearPendingAttempt()).not.toThrow();

    // The controller still gives the same key for a retry on this page.
    const controller = createSubmissionController();
    const ctx = { owner: 'user-ali', totalUzs: 75000 };
    expect(controller.keyFor('body-A', ctx)).toBe(controller.keyFor('body-A', ctx));
  });

  it('works end to end with the default controller across a "reload"', () => {
    const ctx = { owner: 'user-ali', totalUzs: 75000 };
    const key = createSubmissionController().keyFor('body-A', ctx);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toContain('body-A');
    expect(createSubmissionController().keyFor('body-A', ctx)).toBe(key);
    expect(createSubmissionController().keyFor('body-B', ctx)).not.toBe(key);
  });
});

describe('findOrderForAttempt', () => {
  it('finds the order with the same total created after the attempt started', () => {
    const match = summary();
    expect(findOrderForAttempt(attempt(), [match])).toBe(match);
  });

  it('tolerates a phone clock that runs ahead by up to 10 minutes', () => {
    const early = summary({ created_at: new Date(T0 - CLOCK_SKEW_MS).toISOString() });
    expect(findOrderForAttempt(attempt(), [early])).toBe(early);
    const tooEarly = summary({ created_at: new Date(T0 - CLOCK_SKEW_MS - 1).toISOString() });
    expect(findOrderForAttempt(attempt(), [tooEarly])).toBeNull();
  });

  it('does not take an order with another total', () => {
    expect(findOrderForAttempt(attempt(), [summary({ total_uzs: 76000 })])).toBeNull();
  });

  it('picks the first match from a newest-first list', () => {
    const newest = summary({ id: 'newest', created_at: new Date(T0 + 60_000).toISOString() });
    const older = summary({ id: 'older' });
    expect(findOrderForAttempt(attempt(), [newest, older])?.id).toBe('newest');
    expect(findOrderForAttempt(attempt(), [])).toBeNull();
  });
});
