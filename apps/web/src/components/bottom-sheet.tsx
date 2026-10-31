'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FOCUS_RING, PRESS } from './ui-classes';

/** Must match the `duration-200` classes below; the sheet stays mounted for this long on close. */
const EXIT_MS = 200;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface BottomSheetProps {
  open: boolean;
  /** Called for Escape, a tap on the backdrop and the close button (only when `dismissible`). */
  onClose: () => void;
  title: string;
  description?: string | undefined;
  closeLabel: string;
  /** `false` while an action is in flight so the sheet cannot be dismissed half-way. */
  dismissible?: boolean;
  children: ReactNode;
}

/**
 * Modal sheet that slides up from the bottom edge.
 *
 * Motion: the panel moves with `transform: translateY(100%)` -> `0` and the backdrop fades, both
 * 200ms with the drawer / strong ease-out curves, as transitions (so closing mid-open retargets
 * instead of restarting). Entry uses `@starting-style`; a WebView without it just shows the sheet
 * without the slide. Under `prefers-reduced-motion` the slide is dropped and the global rule makes
 * the opacity change instant.
 *
 * Behaviour: `role="dialog"` + `aria-modal`, focus moves in and returns to the trigger on close,
 * Tab is trapped, Escape closes, page scroll is locked, `overscroll-behavior: contain` keeps the
 * sheet's own scrolling from chaining to the page, and the bottom padding includes the
 * safe-area inset.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  closeLabel,
  dismissible = true,
  children,
}: BottomSheetProps) {
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (open || !rendered) return undefined;
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  if (!rendered) return null;
  return (
    <SheetContent
      closing={!open}
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={closeLabel}
      dismissible={dismissible}
    >
      {children}
    </SheetContent>
  );
}

interface SheetContentProps extends Omit<BottomSheetProps, 'open'> {
  closing: boolean;
}

function SheetContent({
  closing,
  onClose,
  title,
  description,
  closeLabel,
  dismissible = true,
  children,
}: SheetContentProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus in on open, back to the trigger on unmount; lock the page behind the sheet.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? panel)?.focus({ preventScroll: true });

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (previouslyFocused instanceof HTMLElement)
        previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (dismissible) {
        event.stopPropagation();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === panelRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={`fixed inset-0 z-40 flex items-end justify-center ${closing ? 'pointer-events-none' : ''}`}
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden="true"
        data-testid="sheet-backdrop"
        data-closing={closing}
        onClick={dismissible ? onClose : undefined}
        className="absolute inset-0 bg-black/50 opacity-100 transition-opacity duration-200 ease-out-strong starting:opacity-0 data-[closing=true]:opacity-0"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        data-closing={closing}
        className={
          'relative flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-2xl bg-background shadow-xl outline-none ' +
          'transform-[translateY(0)] opacity-100 transition-[transform,opacity] duration-200 ease-drawer ' +
          'starting:transform-[translateY(100%)] starting:opacity-0 ' +
          'data-[closing=true]:transform-[translateY(100%)] data-[closing=true]:opacity-0 ' +
          'motion-reduce:transform-none motion-reduce:starting:transform-none ' +
          'motion-reduce:data-[closing=true]:transform-none'
        }
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold [overflow-wrap:anywhere]">
              {title}
            </h2>
            {description === undefined ? null : (
              <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            disabled={!dismissible}
            onClick={onClose}
            className={`-mr-2 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-xl hover:bg-surface-muted disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          {children}
        </div>
      </div>
    </div>
  );
}
