'use client';

import type { DeliveryZone, DistrictCode } from '@muniramarket/contracts';
import { formatUZS } from '@muniramarket/ui';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import {
  districtGroups,
  districtName,
  findServedDistrict,
  zoneHours,
  zoneName,
} from '@/lib/checkout/zones';
import { useDistrictPreference } from '@/lib/delivery/district-preference';
import { useHaptics } from '@/lib/telegram';
import { BottomSheet } from './bottom-sheet';
import { PinIcon } from './icons';
import { RadioCard } from './ui/radio-card';
import { FOCUS_RING, PRESS } from './ui-classes';

export interface DeliveryDistrictProps {
  /** Active zones from the API, or `null` when they could not be loaded. */
  zones: DeliveryZone[] | null;
}

const BUTTON =
  `inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl px-4 text-sm font-semibold ` +
  `${PRESS} ${FOCUS_RING}`;

/**
 * Delivery-district chooser at the top of the storefront. Never blocks browsing: the catalog is
 * right below it either way, and checkout re-checks the district against the live zones.
 *
 * Before a choice it explains, plainly, that the fee and time windows depend on the district (it
 * never claims to know where the customer is). After a choice it is a one-line summary built only
 * from the zone's own data: the fee, the free-delivery threshold when the zone has one, the hours,
 * and a "Change" button. The only thing remembered is the district code (see
 * `district-preference.ts`).
 */
export function DeliveryDistrict({ zones }: DeliveryDistrictProps) {
  const { dict, locale } = useI18n();
  const t = dict.delivery;
  const [stored, setStored, ready] = useDistrictPreference();
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const haptics = useHaptics();

  const groups = zones === null ? [] : districtGroups(zones);
  const served = zones === null ? null : findServedDistrict(zones, stored);
  const staleChoice = stored !== null && zones !== null && served === null;

  const choose = (code: DistrictCode) => {
    setStored(code);
    setOpen(false);
    haptics.impact('light');
    const picked = zones === null ? null : findServedDistrict(zones, code);
    if (picked !== null)
      setAnnouncement(formatMessage(t.saved, { district: districtName(picked.district, locale) }));
  };

  const live = (
    <p aria-live="polite" className="sr-only">
      {announcement}
    </p>
  );

  // Until hydration the stored choice is unknown; hold the space instead of flashing the prompt.
  if (!ready) {
    return (
      <div
        data-testid="delivery-district"
        data-state="pending"
        aria-hidden="true"
        className="h-24 rounded-2xl bg-surface-muted"
      />
    );
  }

  if (zones === null || groups.length === 0) {
    return (
      <section
        aria-label={t.heading}
        data-testid="delivery-district"
        data-state={zones === null ? 'unavailable' : 'no-zones'}
        className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-3"
      >
        <PinBadge />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm leading-5 font-semibold">{t.heading}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {zones === null ? t.unavailable : t.noZones}
          </p>
        </div>
      </section>
    );
  }

  const sheet = (
    <DistrictSheet
      open={open}
      onClose={() => setOpen(false)}
      zones={zones}
      current={served?.district.code ?? null}
      onChoose={choose}
    />
  );

  if (served === null) {
    return (
      <section
        aria-labelledby="delivery-district-heading"
        data-testid="delivery-district"
        data-state="unset"
        className="flex flex-col gap-3 rounded-2xl bg-brand-soft p-3 sm:flex-row sm:items-center"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <PinBadge />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="delivery-district-heading" className="text-sm leading-5 font-semibold">
              {t.heading}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {staleChoice ? t.previousUnavailable : t.prompt}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className={`${BUTTON} w-full bg-primary text-primary-foreground hover:bg-primary-hover sm:w-auto`}
        >
          {t.choose}
        </button>
        {sheet}
        {live}
      </section>
    );
  }

  const { zone, district } = served;
  const name = districtName(district, locale);
  const fee =
    zone.delivery_fee_uzs === 0
      ? t.freeFee
      : formatMessage(t.fee, { fee: formatUZS(zone.delivery_fee_uzs, locale) });
  const freeFrom =
    zone.delivery_fee_uzs > 0 && zone.free_delivery_threshold_uzs !== null
      ? formatMessage(t.freeFrom, {
          threshold: formatUZS(zone.free_delivery_threshold_uzs, locale),
        })
      : null;

  return (
    <section
      aria-labelledby="delivery-district-heading"
      data-testid="delivery-district"
      data-state="set"
      data-district={district.code}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3"
    >
      {/* Name and "Change" share the top row; the zone facts get the card's full width below,
          so long amounts (non-breaking "999 000 so‘m") never run under the button at 320px. */}
      <div className="flex items-center gap-3">
        <PinBadge />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2
            id="delivery-district-heading"
            className="text-xs leading-4 font-medium text-muted-foreground"
          >
            {t.heading}
          </h2>
          <p
            data-testid="delivery-district-name"
            className="text-base leading-6 font-semibold [overflow-wrap:anywhere]"
          >
            {name}
          </p>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`${t.change}: ${t.heading}, ${name}`}
          onClick={() => setOpen(true)}
          className={`${BUTTON} -mr-1 border border-border bg-surface text-foreground hover:bg-surface-muted`}
        >
          {t.change}
        </button>
      </div>
      <ul
        data-testid="delivery-district-facts"
        className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs leading-4 text-muted-foreground sm:pl-[52px]"
      >
        <li data-money>{fee}</li>
        {freeFrom === null ? null : <li data-money>{freeFrom}</li>}
        <li>{formatMessage(t.hours, { time: zoneHours(zone) })}</li>
      </ul>
      <p className="sr-only">{t.checkoutNote}</p>
      {sheet}
      {live}
    </section>
  );
}

function PinBadge() {
  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface text-brand-ink ring-1 ring-border"
    >
      <PinIcon width={20} height={20} />
    </span>
  );
}

interface DistrictSheetProps {
  open: boolean;
  onClose: () => void;
  zones: DeliveryZone[];
  current: DistrictCode | null;
  onChoose: (code: DistrictCode) => void;
}

/**
 * The picker: one radio group per active zone (header: zone name and fee), a "Choose" button that
 * commits. Arrow keys move between districts without committing (native radio behaviour), so a
 * keyboard or screen-reader user can browse the list; Escape, the backdrop and the close button
 * leave the previous choice untouched.
 */
function DistrictSheet({ open, onClose, zones, current, onChoose }: DistrictSheetProps) {
  const { dict, locale } = useI18n();
  const t = dict.delivery;
  const [pending, setPending] = useState<DistrictCode | null>(current);
  const [wasOpen, setWasOpen] = useState(open);
  // Every time the sheet opens it starts from the saved choice, not from an abandoned one.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPending(current);
  }

  const groups = districtGroups(zones);
  const firstCode = groups[0]?.districts[0]?.code ?? null;
  const focusCode = pending ?? firstCode;

  // The sheet focuses the saved district without scrolling; bring it into view so it is not left
  // under the sticky "Choose" bar (an instant jump: nothing to animate on open).
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!open) return;
    formRef.current
      ?.querySelector('input:checked')
      ?.closest('label')
      ?.scrollIntoView?.({ block: 'center' });
  }, [open]);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t.sheetTitle}
      description={t.sheetDescription}
      closeLabel={t.close}
    >
      <form
        ref={formRef}
        data-testid="district-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending !== null) onChoose(pending);
        }}
        className="flex flex-col gap-4"
      >
        {groups.map(({ zone, districts }) => {
          const fee =
            zone.delivery_fee_uzs === 0 ? t.freeFee : formatUZS(zone.delivery_fee_uzs, locale);
          return (
            <fieldset key={zone.id} className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 flex w-full flex-wrap items-baseline justify-between gap-x-3 text-sm">
                {/* Zone names are staff-entered (up to 255 characters): two lines at most here;
                    screen readers still get the whole name. */}
                <span className="line-clamp-2 font-semibold [overflow-wrap:anywhere]">
                  {zoneName(zone, locale)}
                </span>
                <span data-money className="text-muted-foreground">
                  {zone.delivery_fee_uzs === 0 ? fee : formatMessage(t.zoneFee, { fee })}
                </span>
              </legend>
              <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
                {districts.map((district) => (
                  <RadioCard
                    key={district.code}
                    name="delivery-district"
                    value={district.code}
                    checked={pending === district.code}
                    onChange={() => setPending(district.code)}
                    autoFocusInSheet={district.code === focusCode}
                  >
                    <span className="text-base font-medium">{districtName(district, locale)}</span>
                  </RadioCard>
                ))}
              </div>
            </fieldset>
          );
        })}
        <div className="sticky bottom-0 -mx-4 border-t border-border bg-background px-4 pt-3">
          <button
            type="submit"
            disabled={pending === null}
            className={`inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-6 text-base font-semibold text-primary-foreground enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
          >
            {t.confirm}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
