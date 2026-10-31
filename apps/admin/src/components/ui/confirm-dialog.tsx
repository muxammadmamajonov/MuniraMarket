'use client';

import { Button } from '@muniramarket/ui';
import { useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { ALERT_TEXT } from './classes';
import { Modal } from './modal';

export interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  /** Destructive actions get the red button and start with focus on "Cancel". */
  tone?: 'danger' | 'primary';
  /** Runs the action. Resolves with an error message to keep the dialog open, or `null` when done. */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}

/**
 * Confirmation for state changes that are hard to undo or affect other people (archive, delete,
 * role change, block). One request at a time; failures stay inside the dialog.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  onClose,
  returnFocusTo,
}: ConfirmDialogProps) {
  const { dict } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flying = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    if (flying.current) return;
    flying.current = true;
    setPending(true);
    setError(null);
    try {
      const failure = await onConfirm();
      if (failure === null) onClose();
      else setError(failure);
    } finally {
      flying.current = false;
      setPending(false);
    }
  };

  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      dismissible={!pending}
      returnFocusTo={returnFocusTo}
      initialFocusRef={cancelButton}
    >
      {error === null ? null : (
        <p role="alert" className={ALERT_TEXT}>
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          ref={cancelButton}
          type="button"
          onClick={onClose}
          disabled={pending}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-surface px-4 font-semibold transition-transform duration-150 ease-out hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {dict.common.cancel}
        </button>
        <Button
          variant={tone}
          onClick={() => void confirm()}
          disabled={pending}
          data-testid="confirm-action"
        >
          {pending ? dict.common.saving : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
