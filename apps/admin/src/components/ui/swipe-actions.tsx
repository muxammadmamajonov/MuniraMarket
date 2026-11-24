'use client';

import { cx } from '@muniramarket/ui';
import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

/** Width of one revealed action (iOS uses about 74-90pt). */
export const ACTION_WIDTH = 84;
/** Movement before a press becomes a horizontal drag (keeps taps and vertical scrolls intact). */
const DRAG_SLOP = 8;
/** px/ms: a quick flick opens or closes regardless of how far it travelled. */
const FLICK_VELOCITY = 0.11;

export interface SwipeAction {
  /** Short visible label under the icon. */
  label: string;
  /** Full accessible name (which row it acts on). */
  accessibleName: string;
  onSelect: (opener: HTMLElement) => void;
  tone: 'neutral' | 'brand' | 'danger' | 'success';
  icon?: ReactNode;
  testId?: string;
  disabled?: boolean;
}

const TONES: Record<SwipeAction['tone'], string> = {
  neutral: 'bg-[#8e8e93] text-white dark:bg-[#636366]',
  brand: 'bg-foreground text-background',
  success: 'bg-success text-white dark:text-background',
  danger: 'bg-danger text-white dark:text-background',
};

/** Rubber band: past `limit` each extra px moves the row less and less. */
export function rubberBand(offset: number, limit: number): number {
  if (offset > 0) return offset * 0.25;
  if (offset >= -limit) return offset;
  const over = -limit - offset;
  return -limit - over * 0.45;
}

/** Where the row settles after a release (`offset` < 0 when dragged left). */
export function settle(offset: number, velocity: number, width: number): 'open' | 'closed' {
  if (velocity < -FLICK_VELOCITY) return 'open';
  if (velocity > FLICK_VELOCITY) return 'closed';
  return -offset > width / 2 ? 'open' : 'closed';
}

/**
 * A list row whose actions hide behind it, the native way: the row shows its content first; drag
 * it left (a flick is enough) and the actions slide out on the right, iOS Mail style. A tap on
 * an open row or anywhere outside closes it. The row resists past its limit instead of stopping
 * dead and settles on the drawer curve.
 *
 * Pointer events with pointer capture (touch, pen and mouse); `touch-action: pan-y` leaves
 * vertical scrolling to the browser; a second finger is ignored; the transform is written straight
 * to the element during a drag (no React state per frame).
 *
 * Without a gesture: the actions are real buttons after the row in tab order, and focusing one
 * slides the row open, so keyboard and screen-reader users reach them too.
 */
export function SwipeActions({
  open,
  onOpenChange,
  actions,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly SwipeAction[];
  children: ReactNode;
  testId?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const width = ACTION_WIDTH * actions.length;
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    base: number;
    offset: number;
    active: boolean;
    lastX: number;
    lastT: number;
    velocity: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const place = useCallback((offset: number, animate: boolean) => {
    const front = frontRef.current;
    if (front === null) return;
    front.style.transition = animate ? '' : 'none';
    front.style.transform = offset === 0 ? '' : `translateX(${String(offset)}px)`;
  }, []);

  useEffect(() => {
    if (drag.current?.active === true) return;
    place(open ? -width : 0, true);
  }, [open, place, width]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onOpenChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const base = open ? -width : 0;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base,
      offset: base,
      active: false,
      lastX: event.clientX,
      lastT: event.timeStamp,
      velocity: 0,
    };
    suppressClick.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.active) {
      if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      state.active = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const dt = event.timeStamp - state.lastT;
    if (dt > 0) {
      state.velocity = 0.6 * ((event.clientX - state.lastX) / dt) + 0.4 * state.velocity;
    }
    state.lastX = event.clientX;
    state.lastT = event.timeStamp;
    state.offset = rubberBand(state.base + dx, width);
    place(state.offset, false);
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.active) return;
    const next = settle(state.offset, state.velocity, width) === 'open';
    place(next ? -width : 0, true);
    if (next !== open) onOpenChange(next);
  };

  return (
    <div
      ref={rootRef}
      className="relative isolate overflow-hidden"
      data-testid={testId ?? 'swipe-row'}
      data-open={open}
    >
      <div
        ref={frontRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          } else if (open) {
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          }
        }}
        className="relative bg-surface [touch-action:pan-y] transition-transform duration-[240ms] ease-drawer select-none motion-reduce:transition-none"
      >
        {children}
      </div>
      {/* After the row in DOM (and tab) order, painted behind it. */}
      <div className="absolute inset-y-0 right-0 -z-10 flex">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={action.disabled}
            aria-label={action.accessibleName}
            data-testid={action.testId}
            onFocus={() => onOpenChange(true)}
            onBlur={(event) => {
              if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
                onOpenChange(false);
              }
            }}
            onClick={(event) => {
              onOpenChange(false);
              action.onSelect(event.currentTarget);
            }}
            style={{ width: ACTION_WIDTH }}
            className={cx(
              'flex h-full flex-col items-center justify-center gap-1 px-1 text-center text-[12px] leading-tight font-semibold',
              'focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white disabled:opacity-50',
              TONES[action.tone],
            )}
          >
            {action.icon}
            <span className="line-clamp-2">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
