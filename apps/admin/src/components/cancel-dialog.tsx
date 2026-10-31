'use client';

import { Button } from '@muniramarket/ui';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useI18n } from '@/i18n/context';

/** The API requires 3-300 characters for a cancellation reason. */
export const REASON_MIN = 3;
export const REASON_MAX = 300;

export interface CancelDialogProps {
  /** Called with the trimmed reason once it is valid. */
  onConfirm: (reason: string) => void;
  onClose: () => void;
  /** A request is in flight: the form is locked and the dialog cannot be dismissed. */
  pending: boolean;
  /** A failure to show next to the form (the order screen behind it is covered). */
  error: string | null;
  /**
   * The control that opened the dialog; focus goes back to it on close. Passed in rather than read
   * from `document.activeElement` because Safari does not focus a button when it is clicked.
   */
  returnFocusTo: HTMLElement | null;
}

/**
 * Modal that asks for the cancellation reason. Focus moves into the dialog, Tab stays inside it,
 * Escape closes it (unless a request is running) and focus returns to the opener afterwards.
 */
export function CancelDialog({
  onConfirm,
  onClose,
  pending,
  error,
  returnFocusTo,
}: CancelDialogProps) {
  const { dict } = useI18n();
  const copy = dict.order.cancelDialog;
  const titleId = useId();
  const descriptionId = useId();
  const fieldId = useId();
  const errorId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    field.current?.focus();
    return () => {
      if (returnFocusTo?.isConnected === true) returnFocusTo.focus();
    };
  }, [returnFocusTo]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
      setInvalid(true);
      field.current?.focus();
      return;
    }
    setInvalid(false);
    onConfirm(trimmed);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (!pending) onClose();
      return;
    }
    if (event.key !== 'Tab' || dialog.current === null) return;
    const focusable = Array.from(
      dialog.current.querySelectorAll<HTMLElement>('textarea, button:not([disabled])'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-bold">
          {copy.title}
        </h2>
        <p id={descriptionId} className="text-muted-foreground">
          {copy.description}
        </p>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <label htmlFor={fieldId} className="font-medium">
            {copy.reasonLabel}
          </label>
          <textarea
            id={fieldId}
            ref={field}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            rows={4}
            required
            disabled={pending}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            className="w-full rounded-xl border border-border bg-background p-3 focus-visible:outline-2 focus-visible:outline-focus"
          />
          {invalid ? (
            <p id={errorId} role="alert" className="text-sm text-red-700 dark:text-red-300">
              {copy.reasonInvalid}
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={pending}>
              {copy.dismiss}
            </Button>
            <Button type="submit" disabled={pending}>
              {copy.confirm}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
