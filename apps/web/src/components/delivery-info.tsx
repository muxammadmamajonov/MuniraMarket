import type { Dictionary } from '@/i18n';
import { WalletIcon } from './icons';

/**
 * A calm note about how paying works, using only what the app does: payment on delivery. Delivery
 * itself (fee and hours per district) is explained by the district chooser at the top of the page
 * and its map step, which shows the real zone rules for a confirmed point.
 * No offers, discounts or promises.
 */
export function DeliveryInfo({ dict }: { dict: Dictionary }) {
  const { info } = dict.home;
  const items = [
    { key: 'payment', icon: <WalletIcon />, title: info.paymentTitle, text: info.paymentText },
  ];
  return (
    <section
      aria-label={info.paymentTitle}
      data-testid="delivery-info"
      className="grid gap-4 rounded-2xl border border-border bg-surface p-4"
    >
      {items.map((item) => (
        <div key={item.key} className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface text-brand-ink"
          >
            {item.icon}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-sm leading-5 font-semibold">{item.title}</h2>
            <p className="text-sm leading-5 text-muted-foreground">{item.text}</p>
          </div>
        </div>
      ))}
    </section>
  );
}
