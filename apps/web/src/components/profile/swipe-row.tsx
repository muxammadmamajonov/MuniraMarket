'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { TrashIcon } from '../icons';
import { FOCUS_RING } from '../ui-classes';

/** Width of the revealed action (iOS uses ~74-90pt for one action). */
export const ACTION_WIDTH = 88;
/** Movement before a press becomes a horizontal drag (keeps taps and vertical scrolls intact). */
const DRAG_SLOP = 8;
/** px/ms: a quick flick opens or closes regardless of how far it travelled. */
const FLICK_VELOCITY = 0.11;
/** Past this share of the row's width a release deletes outright (iOS "full swipe"). */
const FULL_SWIPE = 0.6;

/** Rubber band: past `limit` each extra px moves the row less and less. */
export function rubberBand(offset: number, limit: number): number {
  if (offset > 0) return offset * 0.25;
  if (offset >= -limit) return offset;
  const over = -limit - offset;
  return -limit - over * 0.45;
}

/**
 * Where the row settles after a release. `offset` is negative when dragged left; `velocity` is
 * px/ms (negative = leftwards). Exported for tests.
 */
export function settle(
  offset: number,
  velocity: number,
  width: number,
): 'open' | 'closed' | 'delete' {
  if (width > 0 && -offset > width * FULL_SWIPE) return 'delete';
  if (velocity < -FLICK_VELOCITY) return 'open';
  if (velocity > FLICK_VELOCITY) return 'closed';
  return -offset > ACTION_WIDTH / 2 ? 'open' : 'closed';
}

export interface SwipeRowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => void;
  deleteLabel: string;
  /** Accessible name of the delete button (includes which address). */
  deleteAccessibleName: string;
  disabled?: boolean;
  children: ReactNode;
}

/**
 * A list row with the native swipe-left-to-delete: drag the row left to reveal a red action, a
 * flick is enough (velocity, not just distance), a long drag past 60% deletes outright, the row
 * resists past its limits instead of stopping dead, and it settles with the iOS drawer curve.
 *
 * Pointer events with pointer capture (mouse, pen and touch alike); `touch-action: pan-y` leaves
 * vertical scrolling to the browser; a second finger is ignored. The transform is written
 * straight to the element during a drag (no React state per frame, no CSS-variable recalc).
 *
 * Without a gesture: the delete button is a real button after the row in tab order; focusing it
 * slides the row open, so keyboard and screen-reader users reach the same action.
 */
export function SwipeRow({
  open,
  onOpenChange,
  onDelete,
  deleteLabel,
  deleteAccessibleName,
  disabled = false,
  children,
}: SwipeRowProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
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

  // React to `open` changes from outside (another row opened, focus, a tap elsewhere).
  useEffect(() => {
    if (drag.current?.active === true) return;
    place(open ? -ACTION_WIDTH : 0, true);
  }, [open, place]);

  // A tap anywhere outside an open row closes it (like iOS).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onOpenChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || drag.current !== null) return; // ignore a second finger
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const base = open ? -ACTION_WIDTH : 0;
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
        // A vertical scroll: let the browser have it.
        drag.current = null;
        return;
      }
      state.active = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const dt = event.timeStamp - state.lastT;
    if (dt > 0) {
      // Smoothed so a single noisy sample at release cannot flip the outcome.
      state.velocity = 0.6 * ((event.clientX - state.lastX) / dt) + 0.4 * state.velocity;
    }
    state.lastX = event.clientX;
    state.lastT = event.timeStamp;
    const width = rootRef.current?.offsetWidth ?? 0;
    state.offset = rubberBand(state.base + dx, Math.max(ACTION_WIDTH, width * FULL_SWIPE + 24));
    place(state.offset, false);
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state === null || state.id !== event.pointerId) return;
    drag.current = null;
    if (!state.active) return;
    const width = rootRef.current?.offsetWidth ?? 0;
    const outcome = settle(state.offset, state.velocity, width);
    if (outcome === 'delete') {
      place(-width, true);
      onDelete();
      return;
    }
    const next = outcome === 'open';
    place(next ? -ACTION_WIDTH : 0, true);
    if (next !== open) onOpenChange(next);
  };

  return (
    <div
      ref={rootRef}
      className="relative isolate overflow-hidden"
      data-testid="swipe-row"
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
            // A tap on an open row closes it instead of following the link.
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
          }
        }}
        className="relative bg-surface [touch-action:pan-y] transition-transform duration-[220ms] ease-drawer select-none motion-reduce:transition-none"
      >
        {children}
      </div>
      {/* After the row in DOM (and tab) order, painted behind it. */}
      <div className="absolute inset-y-0 right-0 -z-10 flex w-full justify-end bg-danger">
        <button
          type="button"
          disabled={disabled}
          aria-label={deleteAccessibleName}
          data-testid="swipe-delete"
          onFocus={() => onOpenChange(true)}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) onOpenChange(false);
          }}
          onClick={onDelete}
          style={{ width: ACTION_WIDTH }}
          className={`flex h-full flex-col items-center justify-center gap-1 text-[13px] font-semibold text-white dark:text-background ${FOCUS_RING} focus-visible:-outline-offset-4 focus-visible:outline-white`}
        >
          <TrashIcon width={20} height={20} aria-hidden="true" />
          {deleteLabel}
        </button>
      </div>
    </div>
  );
}
