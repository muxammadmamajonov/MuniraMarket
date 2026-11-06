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

/**
 * A formatted amount (`formatUZS` output) with one line-break opportunity, before the currency,
 * and none inside the number. The text is unchanged (`<wbr>` adds no characters), so a 10-digit
 * price in a 138px card wraps as "9 999 999 000 / so‘m" instead of running out of the card.
 */
export function MoneyText({ text }: { text: string }) {
  const at = text.lastIndexOf('\u00A0');
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at + 1)}
      <wbr />
      {text.slice(at + 1)}
    </>
  );
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
        <MoneyText text={formatUZS(amount, locale)} />
      </span>
      {oldAmount === undefined ? null : (
        <del className="text-sm text-muted-foreground">
          {oldLabel ? <span className="sr-only">{oldLabel} </span> : null}
          <MoneyText text={formatUZS(oldAmount, locale)} />
        </del>
      )}
    </span>
  );
}
