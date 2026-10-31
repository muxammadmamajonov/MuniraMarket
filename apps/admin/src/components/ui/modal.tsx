'use client';

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@muniramarket/ui';

export interface ModalProps {
  title: string;
  description?: string;
  /** Closes the modal. Ignored while `dismissible` is false (a request is running). */
  onClose: () => void;
  dismissible?: boolean;
  /** The control that opened it; focus goes back there on close (Safari does not focus clicked buttons). */
  returnFocusTo?: HTMLElement | null;
  /** Element to focus on open; defaults to the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** `sheet` is anchored to the bottom edge at every width (the mobile menu). */
  variant?: 'dialog' | 'sheet';
  className?: string;
  children: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

/**
 * Modal dialog: focus moves in, Tab stays inside, Escape closes (unless a request is running),
 * focus returns to the opener, the page behind does not scroll. On phones it is a bottom sheet
 * (`.mm-panel`, see globals.css); on larger screens a centered dialog.
 */
export function Modal({
  title,
  description,
  onClose,
  dismissible = true,
  returnFocusTo = null,
  initialFocusRef,
  variant = 'dialog',
  className,
  children,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = initialFocusRef?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? panel.current)?.focus();

    openCount += 1;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      openCount -= 1;
      if (openCount === 0) document.body.style.overflow = previous;
      if (returnFocusTo?.isConnected === true) returnFocusTo.focus();
    };
  }, [initialFocusRef, returnFocusTo]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const dialog = (
    <div
      className="mm-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx(
          'mm-panel flex max-h-[calc(100dvh-2rem)] w-full flex-col gap-3 overflow-y-auto overscroll-contain',
          'rounded-t-2xl border border-border bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-xl',
          variant === 'dialog'
            ? 'sm:max-w-lg sm:rounded-2xl sm:pb-5'
            : 'sm:max-w-sm sm:rounded-2xl',
          className,
        )}
      >
        <h2 id={titleId} className="text-lg font-bold break-words">
          {title}
        </h2>
        {description === undefined ? null : (
          <p id={descriptionId} className="text-muted-foreground">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
