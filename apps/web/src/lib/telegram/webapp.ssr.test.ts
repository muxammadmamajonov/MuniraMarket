// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { callServerless } from './serverless';
import { getTelegramWebApp, isTelegramMiniApp } from './webapp';

describe('Telegram adapter on the server (no window)', () => {
  it('is SSR-safe', () => {
    expect(typeof window).toBe('undefined');
    expect(getTelegramWebApp()).toBeNull();
    expect(isTelegramMiniApp()).toBe(false);
  });

  it('callServerless rejects with NOT_IN_TELEGRAM', async () => {
    await expect(callServerless('x')).rejects.toMatchObject({ type: 'NOT_IN_TELEGRAM' });
  });
});
