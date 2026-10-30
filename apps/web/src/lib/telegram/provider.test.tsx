import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramProvider, useTelegram } from './provider';
import { installWebApp, makeWebApp, uninstallWebApp } from './test-helpers';

function Probe() {
  const telegram = useTelegram();
  return (
    <p data-testid="probe">
      {telegram.kind === 'telegram' ? `telegram:${telegram.initData}` : 'browser'}
    </p>
  );
}

afterEach(() => {
  uninstallWebApp();
});

describe('TelegramProvider / useTelegram', () => {
  it('provides the browser fallback when Telegram is absent', () => {
    render(
      <TelegramProvider>
        <Probe />
      </TelegramProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('browser');
  });

  it('provides the browser fallback when the script is loaded outside Telegram', () => {
    installWebApp(makeWebApp({ initData: '' }));
    render(
      <TelegramProvider>
        <Probe />
      </TelegramProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('browser');
  });

  it('provides webApp and raw initData inside Telegram, and signals ready/expand once', () => {
    const webApp = makeWebApp({ initData: 'signed-init-data' });
    installWebApp(webApp);
    render(
      <TelegramProvider>
        <Probe />
      </TelegramProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('telegram:signed-init-data');
    expect(webApp.ready).toHaveBeenCalledTimes(1);
    expect(webApp.expand).toHaveBeenCalledTimes(1);
  });

  it('does not call ready/expand in the browser', () => {
    const webApp = makeWebApp({ initData: '' });
    installWebApp(webApp);
    render(
      <TelegramProvider>
        <Probe />
      </TelegramProvider>,
    );
    expect(webApp.ready).not.toHaveBeenCalled();
    expect(webApp.expand).not.toHaveBeenCalled();
  });

  it('throws a helpful error outside the provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Probe />)).toThrow(/TelegramProvider/);
    } finally {
      error.mockRestore();
    }
  });
});
