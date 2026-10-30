import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { installWebApp, makeWebApp, uninstallWebApp } from '@/lib/telegram/test-helpers';
import { TelegramProvider } from '@/lib/telegram';
import { TelegramStatus } from './telegram-status';

const props = { label: 'Env', telegramText: 'Telegram Mini App', browserText: 'Browser' };

afterEach(() => {
  uninstallWebApp();
});

describe('TelegramStatus', () => {
  it('shows Browser outside Telegram', () => {
    render(
      <TelegramProvider>
        <TelegramStatus {...props} />
      </TelegramProvider>,
    );
    expect(screen.getByTestId('telegram-status')).toHaveTextContent('Env: Browser');
  });

  it('shows Telegram Mini App inside Telegram', () => {
    installWebApp(makeWebApp());
    render(
      <TelegramProvider>
        <TelegramStatus {...props} />
      </TelegramProvider>,
    );
    expect(screen.getByTestId('telegram-status')).toHaveTextContent('Env: Telegram Mini App');
  });
});
