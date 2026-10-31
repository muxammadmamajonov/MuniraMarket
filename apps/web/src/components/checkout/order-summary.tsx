'use client';

import type { Cart, CartLine, CheckoutQuote, DeliveryZone } from '@muniramarket/contracts';
import { formatUZS } from '@muniramarket/ui';
import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import { formatMessage, formatPlural } from '@/i18n/format';
import { localizedName } from '@/lib/catalog';
import type { QuoteState } from '@/lib/checkout/use-checkout';
import { CARD, ERROR_TEXT, LINK_BUTTON_SECONDARY } from '../ui-classes';

export interface OrderSummaryProps {
  cart: Cart;
  quote: QuoteState;
  /** The quote for the district currently selected, or `null`. */
  readyQuote: CheckoutQuote | null;
  /** The chosen delivery window, already worded ("Today, 31.10 · 10:00–12:00"), or `null`. */
  slotText?: string | null;
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
 * Lines, subtotal, delivery fee and total. Every amount is the server's (the quote once a
 * district is chosen, the cart before); nothing is added up here. A fee of 0 reads "Free".
 */
export function OrderSummary({ cart, quote, readyQuote, slotText = null }: OrderSummaryProps) {
  const { dict, locale } = useI18n();
  const t = dict.checkout.summary;
  const lines: CartLine[] = readyQuote?.items ?? cart.items;
  const itemCount = readyQuote?.item_count ?? cart.item_count;
  const subtotal = readyQuote?.subtotal_uzs ?? cart.subtotal_uzs;
  const zone: DeliveryZone | null = readyQuote?.zone ?? null;

  let delivery: string;
  if (readyQuote !== null) {
    delivery =
      readyQuote.delivery_fee_uzs === 0 ? t.free : formatUZS(readyQuote.delivery_fee_uzs, locale);
  } else if (quote.kind === 'loading') delivery = t.calculating;
  else delivery = t.pickDistrict;

  const total = readyQuote === null ? '—' : formatUZS(readyQuote.total_uzs, locale);
  const remaining = readyQuote?.free_delivery_remaining_uzs ?? null;
  const issues = readyQuote?.issues ?? [];

  return (
    <section
      aria-labelledby="checkout-summary"
      className={`${CARD} flex min-w-0 flex-col gap-3`}
      aria-busy={quote.kind === 'loading'}
    >
      <h2 id="checkout-summary" className="text-lg font-bold">
        {dict.checkout.sections.summary}
      </h2>

      <ul className="flex flex-col divide-y divide-border" data-testid="summary-lines">
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

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        {slotText === null ? null : (
          <p className="flex flex-col pb-1" data-testid="checkout-slot-summary">
            <span className="text-sm text-muted-foreground">{dict.checkout.slots.summary}</span>
            <span className="font-medium [overflow-wrap:anywhere]">{slotText}</span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {formatPlural(dict.checkout.summary.items, itemCount, locale)}
        </p>
        <Row label={t.subtotal} value={formatUZS(subtotal, locale)} testId="checkout-subtotal" />
        <Row label={t.delivery} value={delivery} testId="checkout-delivery" />
        <Row label={t.total} value={total} strong testId="checkout-total" />
      </div>

      <div aria-live="polite" className="flex flex-col gap-2">
        {quote.kind === 'loading' ? (
          <p className="text-sm text-muted-foreground">{t.calculating}</p>
        ) : null}
        {remaining !== null && remaining > 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="free-delivery-hint">
            {formatMessage(t.freeRemaining, { amount: formatUZS(remaining, locale) })}
          </p>
        ) : null}
        {remaining === 0 ? <p className="text-sm text-muted-foreground">{t.freeReached}</p> : null}
        {issues.includes('below_min_order') && zone !== null ? (
          <p role="alert" className={ERROR_TEXT} data-testid="below-min">
            {formatMessage(t.belowMin, { min: formatUZS(zone.min_order_uzs, locale) })}
          </p>
        ) : null}
        {issues.includes('cart_has_issues') ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className={ERROR_TEXT} data-testid="cart-issues">
              {t.cartIssues}
            </p>
            <Link href={`/${locale}/cart`} className={LINK_BUTTON_SECONDARY}>
              {dict.checkout.backToCart}
            </Link>
          </div>
        ) : null}
        {quote.kind === 'failed' ? (
          <p role="alert" className={ERROR_TEXT}>
            {quote.failure.kind === 'district_not_served' ? t.districtNotServed : t.quoteFailed}
          </p>
        ) : null}
        {readyQuote !== null && !readyQuote.zone.is_open_now ? (
          <p className="text-sm text-muted-foreground" data-testid="zone-closed">
            {formatMessage(dict.checkout.closedNow, { time: readyQuote.zone.opens_at })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
