import { afterEach, describe, expect, it } from 'vitest';
import { LOGIN_STATE_MAX_AGE_MS, beginLoginState, consumeLoginState } from './login-state';

afterEach(() => {
  window.sessionStorage.clear();
});

describe('Telegram login state', () => {
  it('accepts the state issued in this tab exactly once', () => {
    const state = beginLoginState(1_000);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeLoginState(state, 2_000)).toBe(true);
    expect(consumeLoginState(state, 2_000)).toBe(false);
  });

  it('rejects a callback that this tab never started (attacker link)', () => {
    expect(consumeLoginState('0'.repeat(32), 1_000)).toBe(false);
  });

  it('rejects a missing or different state and consumes the stored one', () => {
    beginLoginState(1_000);
    expect(consumeLoginState(null, 1_000)).toBe(false);
    const state = beginLoginState(1_000);
    expect(consumeLoginState('f'.repeat(32), 1_000)).toBe(false);
    expect(consumeLoginState(state, 1_000)).toBe(false);
  });

  it('rejects an expired or future-dated state', () => {
    const expired = beginLoginState(0);
    expect(consumeLoginState(expired, LOGIN_STATE_MAX_AGE_MS + 1)).toBe(false);
    const future = beginLoginState(10_000);
    expect(consumeLoginState(future, 0)).toBe(false);
  });

  it('rejects malformed received values', () => {
    beginLoginState(0);
    expect(consumeLoginState('<script>', 0)).toBe(false);
  });
});
