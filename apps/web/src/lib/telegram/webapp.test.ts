import { afterEach, describe, expect, it } from 'vitest';
import { installWebApp, makeWebApp, uninstallWebApp } from './test-helpers';
import { getTelegramWebApp, isTelegramMiniApp } from './webapp';

afterEach(() => {
  uninstallWebApp();
});

describe('getTelegramWebApp / isTelegramMiniApp', () => {
  it('returns null and false when window.Telegram is absent (plain browser)', () => {
    expect(getTelegramWebApp()).toBeNull();
    expect(isTelegramMiniApp()).toBe(false);
  });

  it('returns null when Telegram exists without WebApp', () => {
    window.Telegram = {};
    expect(getTelegramWebApp()).toBeNull();
    expect(isTelegramMiniApp()).toBe(false);
  });

  it('returns the WebApp inside Telegram', () => {
    const webApp = makeWebApp();
    installWebApp(webApp);
    expect(getTelegramWebApp()).toBe(webApp);
    expect(isTelegramMiniApp()).toBe(true);
  });

  it('treats the script loaded in an ordinary browser (empty initData) as not a Mini App', () => {
    const webApp = makeWebApp({ initData: '', platform: 'unknown' });
    installWebApp(webApp);
    expect(getTelegramWebApp()).toBe(webApp);
    expect(isTelegramMiniApp()).toBe(false);
  });
});
