'use client';

import type { HTMLAttributes } from 'react';
import { cx } from '../cx';

export interface QuantityStepperProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'children'
> {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Accessible labels (already localized). */
  decreaseLabel: string;
  increaseLabel: string;
  /** Accessible name of the whole control, e.g. "Quantity". */
  label: string;
}

const STEP_BUTTON =
  'inline-flex min-h-11 min-w-11 items-center justify-center text-xl font-semibold ' +
  'hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40';

/** Minus / value / plus control. Values are clamped to `[min, max]`; touch targets are 44px. */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  disabled = false,
  decreaseLabel,
  increaseLabel,
  label,
  className,
  ...rest
}: QuantityStepperProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx(
        'inline-flex items-center overflow-hidden rounded-xl border border-border bg-surface',
        className,
      )}
      {...rest}
    >
      <button
        type="button"
        aria-label={decreaseLabel}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={STEP_BUTTON}
      >
        <span aria-hidden="true">−</span>
      </button>
      <output aria-live="polite" className="min-w-10 px-1 text-center font-semibold tabular-nums">
        {value}
      </output>
      <button
        type="button"
        aria-label={increaseLabel}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={STEP_BUTTON}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
