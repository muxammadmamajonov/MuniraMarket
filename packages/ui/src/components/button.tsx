import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../cx';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold ' +
  'transition-[background-color,transform] duration-150 ease-out active:scale-[0.98] ' +
  'motion-reduce:transition-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'border border-border bg-surface text-foreground hover:bg-surface-muted',
  // Destructive confirmations only (archive, delete, block): red, with text that stays AA on it.
  danger: 'bg-red-700 text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500',
};

// Every size keeps a 44px minimum touch target (WCAG 2.5.5 / Apple HIG).
const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-11 min-w-11 px-4 text-base',
  lg: 'min-h-12 min-w-11 px-6 text-lg',
};

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={cx(BASE, VARIANTS[variant], SIZES[size], className)} {...rest} />
  );
}
