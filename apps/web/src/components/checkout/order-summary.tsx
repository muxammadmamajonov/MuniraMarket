'use client';

import type { Cart, CartLine, CheckoutQuote } from '@muniramarket/contracts';
import { formatUZS } from '@muniramarket/ui';
import { useI18n } from '@/i18n/context';
import { formatMessage, formatPlural } from '@/i18n/format';
import { localizedName } from '@/lib/catalog';
import type { QuoteState } from '@/lib/checkout/use-checkout';
import { CARD, ERROR_TEXT, SECTION_TITLE } from '../ui-classes';
import { RetryButton } from './retry-button';

export interface OrderSummaryProps {
  cart: Cart;
  quote: QuoteState;
  /** The current quote, or `null` while it is loading or failed. */
  readyQuote: CheckoutQuote | null;
  /** Seconds left of a rate-limit wait, 0 when there is none. */
  cooldown?: number;
  /** Asks for the quote again (shown with the message when pricing the cart failed). */
  onRetryQuote?: () => void;
}

function Row({
  label,
  value,
  strong = false,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <p className={`flex items-baseline justify-between gap-3 ${strong ? 'text-lg font-bold' : ''}`}>
      <span className="min-w-0">{label}</span>
      <span
        data-money
        className="shrink-0"
        {...(testId === undefined ? {} : { 'data-testid': testId })}
      >
        {value}
      </span>
    </p>
  );
}

/**
 * Lines and total. Every amount is the server's (the quote, the cart before it arrives); nothing
 * is added up here. There is no delivery line: a Yandex Go courier brings the order and is paid
 * by the customer on receipt, which one plain line under the total says.
 */
export function OrderSummary({
  cart,
  quote,
  readyQuote,
  cooldown = 0,
  onRetryQuote,
}: OrderSummaryProps) {
  const { dict, locale } = useI18n();
  const t = dict.checkout.summary;
  const lines: CartLine[] = readyQuote?.items ?? cart.items;
  const itemCount = readyQuote?.item_count ?? cart.item_count;
  const total = formatUZS(readyQuote?.total_uzs ?? cart.total_uzs, locale);
  const issues = readyQuote?.issues ?? [];

  return (
    <section
      aria-labelledby="checkout-summary"
      className={`${CARD} flex min-w-0 flex-col gap-3`}
      aria-busy={quote.kind === 'loading'}
    >
      <h2 id="checkout-summary" className={SECTION_TITLE}>
        {dict.checkout.sections.summary}
      </h2>

      <ul className="flex flex-col divide-y divide-hairline" data-testid="summary-lines">
        {lines.map((line) => {
          const name = localizedName(line.product, locale);
          return (
            <li
              key={line.product.id}
              data-testid="summary-line"
              data-issue={line.issue ?? undefined}
              className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="font-medium [overflow-wrap:anywhere]">{name}</p>
                <p className="text-sm text-muted-foreground">
                  {formatMessage(dict.orders.detail.lineBreakdown, {
                    quantity: line.quantity,
                    price: formatUZS(line.product.price_uzs, locale),
                    unit: dict.units[line.product.unit],
                  })}
                </p>
                {line.issue === null ? null : (
                  <p className={ERROR_TEXT}>
                    {line.issue === 'product_inactive'
                      ? dict.cart.issueInactive
                      : formatMessage(dict.cart.issueInsufficientStock, {
                          available: line.product.stock_quantity ?? 0,
                        })}
                  </p>
                )}
              </div>
              {line.issue === null ? (
                <span data-money className="shrink-0 font-semibold">
                  {formatUZS(line.line_total_uzs, locale)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1.5 border-t border-hairline pt-3">
        <p className="text-sm text-muted-foreground">
          {formatPlural(dict.checkout.summary.items, itemCount, locale)}
        </p>
        <Row label={t.total} value={total} strong testId="checkout-total" />
        <p className="text-sm leading-5 text-muted-foreground" data-testid="checkout-courier-note">
          {dict.checkout.courierNote}
        </p>
      </div>

      <div aria-live="polite" className="flex flex-col gap-2">
        {quote.kind === 'loading' ? (
          <p className="text-sm text-muted-foreground">{t.calculating}</p>
        ) : null}
        {issues.includes('cart_has_issues') ? (
          <p role="alert" className={ERROR_TEXT} data-testid="cart-issues">
            {t.cartIssues}
          </p>
        ) : null}
        {quote.kind === 'failed' ? (
          // `data-field="quote"`: where a refused submit moves focus when the cart could not be
          // priced, so the message (and the retry) is not left below the fold.
          <div
            tabIndex={-1}
            data-field="quote"
            data-testid="quote-error"
            data-failure={quote.failure.kind}
            className="flex flex-col items-start gap-2 outline-none"
          >
            <p role="alert" className={ERROR_TEXT}>
              {quote.failure.kind === 'rate_limited'
                ? formatMessage(dict.checkout.failures.rateLimited, {
                    seconds: quote.failure.seconds,
                  })
                : t.quoteFailed}
            </p>
            {onRetryQuote === undefined ? null : (
              <RetryButton cooldown={cooldown} onClick={onRetryQuote} testId="quote-retry" />
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
