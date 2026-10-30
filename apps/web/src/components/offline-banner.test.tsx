import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import {
  reportNetworkFailure,
  reportNetworkSuccess,
  resetNetworkStatus,
} from '@/lib/network-status';
import { OfflineBanner } from './offline-banner';

function renderBanner(locale: 'uz' | 'ru' = 'uz') {
  return render(
    <LocaleProvider locale={locale}>
      <OfflineBanner />
    </LocaleProvider>,
  );
}

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetNetworkStatus();
});

describe('OfflineBanner', () => {
  it('is hidden while online', () => {
    renderBanner();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('shows a localized message when the browser goes offline and hides it when back online', () => {
    renderBanner('ru');
    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Нет подключения к интернету');

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('is shown at mount when the browser is already offline', () => {
    setOnline(false);
    renderBanner('uz');
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Internet aloqasi yo‘q');
  });

  it('shows after a failed fetch even if navigator.onLine is true, and clears on success', () => {
    renderBanner();
    act(() => reportNetworkFailure());
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    act(() => reportNetworkSuccess());
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('clears a recorded failure when the browser reports being online again', () => {
    renderBanner();
    act(() => reportNetworkFailure());
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });
});
