'use client';

import { useId, type ReactNode } from 'react';
import { ERROR_TEXT } from './ui-classes';

export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
}

export interface FormFieldProps {
  label: string;
  /** Localized word shown after the label of an optional field. */
  optionalLabel?: string;
  /** Localized error message; marks the control invalid. */
  error?: string | undefined;
  hint?: ReactNode;
  required?: boolean;
  /** Counter or other note aligned with the label row. */
  aside?: ReactNode;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + hint + error, wired with `htmlFor` / `aria-describedby` / `aria-invalid`.
 * The label wraps instead of truncating (translated labels are long) and the error is announced
 * politely when it appears.
 */
export function FormField({
  label,
  optionalLabel,
  error,
  hint,
  required = false,
  aside,
  className,
  children,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [error === undefined ? null : errorId, hint === undefined ? null : hintId]
      .filter((value) => value !== null)
      .join(' ') || undefined;

  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
          {label}
          {optionalLabel === undefined ? null : (
            <span className="font-normal text-muted-foreground"> · {optionalLabel}</span>
          )}
        </label>
        {aside}
      </div>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error === undefined ? undefined : true,
        'aria-required': required ? true : undefined,
      })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} role="alert" className={ERROR_TEXT}>
          {error}
        </p>
      )}
    </div>
  );
}
