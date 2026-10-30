import type { Locale } from '@muniramarket/contracts';
import type { HTMLAttributes } from 'react';
import { cx } from '../cx';
import { formatUZS } from '../format-uzs';

export interface PriceProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Current price, integer UZS. */
  amount: number;
  /** Previous price, integer UZS. Rendered struck through when provided. */
  oldAmount?: number;
  locale: Locale;
  /** Screen-reader label announced before the current price when `oldAmount` is set. */
  currentLabel?: string;
  /** Screen-reader label announced before the old price. */
  oldLabel?: string;
}

export function Price({
  amount,
  oldAmount,
  locale,
  currentLabel,
  oldLabel,
  className,
  ...rest
}: PriceProps) {
  return (
    <span className={cx('inline-flex flex-wrap items-baseline gap-x-2', className)} {...rest}>
      <span className="font-semibold text-foreground">
        {currentLabel ? <span className="sr-only">{currentLabel} </span> : null}
        {formatUZS(amount, locale)}
      </span>
      {oldAmount === undefined ? null : (
        <del className="text-sm text-muted-foreground">
          {oldLabel ? <span className="sr-only">{oldLabel} </span> : null}
          {formatUZS(oldAmount, locale)}
        </del>
      )}
    </span>
  );
}
