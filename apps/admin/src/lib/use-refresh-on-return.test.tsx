import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRefreshOnReturn } from './use-refresh-on-return';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('useRefreshOnReturn', () => {
  it('refreshes on focus and visibility, but not twice within 10 s', () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshOnReturn(refresh));
    window.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled(); // just mounted: the page loaded its own data
    vi.advanceTimersByTime(11_000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('polls every 30 s while visible and stays quiet while hidden', () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshOnReturn(refresh));
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    vi.advanceTimersByTime(120_000);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled and cleans up on unmount', () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useRefreshOnReturn(refresh, false));
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
    const live = vi.fn();
    const second = renderHook(() => useRefreshOnReturn(live));
    second.unmount();
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(live).not.toHaveBeenCalled();
  });
});
