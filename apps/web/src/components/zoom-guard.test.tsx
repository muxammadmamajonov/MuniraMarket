import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ZoomGuard } from './zoom-guard';

function gesture(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

describe('ZoomGuard', () => {
  it("cancels WebKit's pinch gestures while mounted, and stops after unmount", () => {
    const { unmount } = render(<ZoomGuard />);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      expect(gesture(type).defaultPrevented, type).toBe(true);
    }
    unmount();
    expect(gesture('gesturestart').defaultPrevented).toBe(false);
  });

  it('leaves touch scrolling alone', () => {
    render(<ZoomGuard />);
    expect(gesture('touchmove').defaultPrevented).toBe(false);
    expect(gesture('wheel').defaultPrevented).toBe(false);
  });
});
