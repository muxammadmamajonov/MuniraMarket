import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCooldown } from './use-cooldown';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useCooldown', () => {
  it('is 0 until started, then counts down once a second and stops at 0', () => {
    const { result } = renderHook(() => useCooldown());
    expect(result.current.seconds).toBe(0);

    act(() => result.current.start(3));
    expect(result.current.seconds).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(2);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(0);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.seconds).toBe(0);
  });

  it('restarts from a new value, rounds up, and never goes negative', () => {
    const { result } = renderHook(() => useCooldown());
    act(() => result.current.start(2.2));
    expect(result.current.seconds).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.start(10));
    expect(result.current.seconds).toBe(10);
    act(() => result.current.start(-4));
    expect(result.current.seconds).toBe(0);
  });

  it('stops its timer when unmounted', () => {
    const { result, unmount } = renderHook(() => useCooldown());
    act(() => result.current.start(5));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
