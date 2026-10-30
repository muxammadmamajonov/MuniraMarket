import { vi } from 'vitest';
import type { TelegramWebApp } from './types';

/** Builds a fake `window.Telegram.WebApp` for tests. Test-only; not imported by app code. */
export function makeWebApp(overrides: Partial<TelegramWebApp> = {}): TelegramWebApp {
  return {
    initData: 'query_id=AAA&user=%7B%7D&auth_date=1&hash=abc',
    initDataUnsafe: {},
    colorScheme: 'light',
    themeParams: {},
    platform: 'android',
    version: '9.0',
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    BackButton: {
      isVisible: false,
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn(),
      offClick: vi.fn(),
    },
    MainButton: {
      isVisible: false,
      isActive: true,
      text: '',
      setText: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      showProgress: vi.fn(),
      hideProgress: vi.fn(),
      onClick: vi.fn(),
      offClick: vi.fn(),
    },
    ...overrides,
  };
}

export function installWebApp(webApp: TelegramWebApp): void {
  window.Telegram = { WebApp: webApp };
}

export function uninstallWebApp(): void {
  delete window.Telegram;
}
