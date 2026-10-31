'use client';

import { useId, type ReactNode } from 'react';
import { ALERT_TEXT, INPUT, TEXTAREA } from './classes';
import { cx } from '@muniramarket/ui';

export interface ControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': boolean;
}

export interface FieldProps {
  label: string;
  /** Marks the field optional in the label (the dictionary's "optional"). */
  optionalLabel?: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  /** Renders the control with the ids that tie label, hint and error to it. */
  children: (control: ControlProps) => ReactNode;
}

/** Label + control + hint + error, wired with `htmlFor`, `aria-describedby` and `aria-invalid`. */
export function Field({ label, optionalLabel, hint, error, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== '';
  const describedBy =
    [hint === undefined ? null : hintId, hasError ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-medium">
        {label}
        {optionalLabel === undefined ? null : (
          <span className="font-normal text-muted-foreground"> ({optionalLabel})</span>
        )}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': hasError })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {hasError ? (
        <p id={errorId} role="alert" className={ALERT_TEXT}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type InputAttrs = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>;

export interface TextFieldProps extends Omit<FieldProps, 'children'> {
  input: InputAttrs;
  testId?: string;
}

export function TextField({ input, testId, ...field }: TextFieldProps) {
  return (
    <Field {...field}>
      {(control) => <input {...control} {...input} data-testid={testId} className={INPUT} />}
    </Field>
  );
}

export interface TextAreaFieldProps extends Omit<FieldProps, 'children'> {
  textarea: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'>;
  testId?: string;
}

export function TextAreaField({ textarea, testId, ...field }: TextAreaFieldProps) {
  return (
    <Field {...field}>
      {(control) => (
        <textarea {...control} {...textarea} data-testid={testId} className={TEXTAREA} />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends Omit<FieldProps, 'children'> {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  testId,
  ...field
}: SelectFieldProps) {
  return (
    <Field {...field}>
      {(control) => (
        <select
          {...control}
          value={value}
          disabled={disabled}
          data-testid={testId}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT}
        >
          {placeholder === undefined ? null : <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export interface CheckboxFieldProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  testId?: string;
}

/** A checkbox with a 44px tall label row, so the whole line is the tap target. */
export function CheckboxField({
  label,
  hint,
  checked,
  onChange,
  disabled,
  testId,
}: CheckboxFieldProps) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className="flex min-h-11 items-center gap-3 font-medium">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          data-testid={testId}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          className="size-5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <span className="min-w-0 break-words">{label}</span>
      </label>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="pl-8 text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Integer input as text (no spinner, no wheel changes, no locale surprises); the numeric keypad opens on phones. */
export function integerInputAttrs(
  value: string,
  onChange: (value: string) => void,
  opts: { allowNegative?: boolean; name?: string } = {},
): InputAttrs {
  return {
    type: 'text',
    inputMode: opts.allowNegative === true ? 'text' : 'numeric',
    autoComplete: 'off',
    value,
    name: opts.name,
    onChange: (event) => onChange(event.target.value),
  };
}

/** Plain single-line text input attributes (no autocomplete noise for codes and slugs). */
export function textInputAttrs(value: string, onChange: (value: string) => void): InputAttrs {
  return {
    type: 'text',
    autoComplete: 'off',
    value,
    onChange: (event) => onChange(event.target.value),
  };
}
