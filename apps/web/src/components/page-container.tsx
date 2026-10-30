import { cx } from '@muniramarket/ui';
import type { HTMLAttributes } from 'react';

/** Page-width wrapper for the storefront (wider than the UI package's default `Container`). */
export function PageContainer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('mx-auto w-full max-w-5xl px-4 sm:px-6', className)} {...rest} />;
}
