'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatAddressLine, type Address } from '@/lib/address/address';
import { savedToAddress } from '@/lib/address/saved';
import { useDeliveryAddress } from '@/lib/address/storage';
import { useHaptics } from '@/lib/telegram';
import { AddressChooser, useSavedAddresses } from './address-chooser';
import { ChevronRightIcon, PinIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

/**
 * The delivery address at the top of the storefront. Never blocks browsing: the catalog is right
 * below it either way. Tapping it offers the account's saved addresses first (when there are any)
 * and otherwise opens the map picker straight away; the chosen address is what checkout starts
 * from.
 */
export function DeliveryAddressCard() {
  const { dict } = useI18n();
  const t = dict.address;
  const [address, setAddress, ready] = useDeliveryAddress();
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const haptics = useHaptics();
  const { items: saved } = useSavedAddresses();

  // Nothing chosen on this device yet but a saved default: show that one (once).
  const prefilled = useRef(false);
  useEffect(() => {
    if (!ready || prefilled.current || saved === null) return;
    prefilled.current = true;
    const preferred = saved.find((item) => item.is_default) ?? saved[0];
    if (address === null && preferred !== undefined) setAddress(savedToAddress(preferred));
  }, [ready, saved, address, setAddress]);

  const save = (next: Address) => {
    setAddress(next);
    setOpen(false);
    haptics.impact('light');
    setAnnouncement(t.saved);
  };

  // Until hydration the stored address is unknown; hold the space instead of flashing the prompt.
  if (!ready) {
    return (
      <div
        data-testid="delivery-address"
        data-state="pending"
        aria-hidden="true"
        className="h-16 rounded-3xl bg-surface"
      />
    );
  }

  const line = address === null ? null : formatAddressLine(address, t);

  return (
    <section
      aria-label={t.heading}
      data-testid="delivery-address"
      data-state={line === null ? 'unset' : 'set'}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={`flex w-full items-center gap-3 rounded-3xl bg-surface p-2.5 pr-3 text-left hover:bg-surface/70 ${PRESS} ${FOCUS_RING}`}
      >
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <PinIcon width={20} height={20} />
        </span>
        {line === null ? (
          <span className="min-w-0 flex-1 text-[15px] leading-5 font-semibold">
            {t.choosePrompt}
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs leading-4 font-medium text-muted-foreground">{t.heading}</span>
            <span
              data-testid="delivery-address-line"
              className="truncate text-base leading-6 font-semibold"
            >
              {line}
            </span>
          </span>
        )}
        <span className="sr-only">{line === null ? '' : t.change}</span>
        <ChevronRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </button>
      <AddressChooser
        open={open}
        onClose={() => setOpen(false)}
        current={address}
        saved={saved}
        onChoose={save}
      />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
