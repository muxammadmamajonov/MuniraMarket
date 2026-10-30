import type { HTMLAttributes } from 'react';
import { cx } from '../cx';

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

/** Pulsing placeholder block for content that is loading. Hidden from assistive technology. */
export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse rounded-xl bg-surface-muted', className)}
      {...rest}
    />
  );
}
