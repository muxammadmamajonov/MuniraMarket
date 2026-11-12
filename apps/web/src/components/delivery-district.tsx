'use client';

import type { DeliveryZone, District, DistrictCode } from '@muniramarket/contracts';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { districtGroups, districtName, findServedDistrict } from '@/lib/checkout/zones';
import { useDistrictPreference } from '@/lib/delivery/district-preference';
import { useHaptics } from '@/lib/telegram';
import { AddressPicker } from './address-picker';
import { BottomSheet } from './bottom-sheet';
import { ChevronRightIcon, MapIcon, PinIcon } from './icons';
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
 * Delivery chooser at the top of the storefront. Never blocks browsing: the catalog is right
 * below it either way, and checkout re-checks the district against the live zones and prices the
 * delivery there (fees, thresholds and hours are not shown on the storefront).
 *
 * Before a choice the whole card is one button ("Choose the delivery address"). After a choice it
 * shows only the district and a "Change" button. The district is the real coverage choice and the
 * only thing remembered (see `district-preference.ts`). "Choose on the map" in the sheet opens the
 * map step (`address-picker.tsx`): a confirmed point is checked against the live zones and can
 * select its district; the point itself is never saved. The exact address is typed at checkout.
 */
export function DeliveryDistrict({ zones }: DeliveryDistrictProps) {
  const { dict, locale } = useI18n();
  const t = dict.delivery;
  const [stored, setStored, ready] = useDistrictPreference();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const haptics = useHaptics();

  const groups = zones === null ? [] : districtGroups(zones);
  const served = zones === null ? null : findServedDistrict(zones, stored);
  const staleChoice = stored !== null && zones !== null && served === null;

  const choose = (code: DistrictCode) => {
    setStored(code);
    setSheetOpen(false);
    haptics.impact('light');
    const picked = zones === null ? null : findServedDistrict(zones, code);
    if (picked !== null)
      setAnnouncement(formatMessage(t.saved, { district: districtName(picked.district, locale) }));
  };

  // Fullscreen is requested for the whole Mini App at launch (`TelegramChrome`), not only for
  // this picker. Opening and closing the map must never make the app jump between modes.
  const openMap = () => {
    setSheetOpen(false);
    setMapOpen(true);
  };

  // Leaving the map always returns to the district list, where the real choice is made.
  const closeMap = () => {
    setMapOpen(false);
    setSheetOpen(true);
  };

  // A served district picked from a map result: only its code is saved (the point is not), and
  // the customer lands back on the storefront with the summary updated.
  const chooseFromMap = (code: DistrictCode) => {
    setMapOpen(false);
    choose(code);
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
        className="h-[68px] rounded-2xl bg-surface-muted"
      />
    );
  }

  if (zones === null || groups.length === 0) {
    return (
      <section
        aria-label={t.heading}
        data-testid="delivery-district"
        data-state={zones === null ? 'unavailable' : 'no-zones'}
        className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3"
      >
        <PinBadge />
        <p className="min-w-0 text-sm leading-5 text-muted-foreground">
          {zones === null ? t.unavailable : t.noZones}
        </p>
      </section>
    );
  }

  const overlays = (
    <>
      <DistrictSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        zones={zones}
        current={served?.district.code ?? null}
        onChoose={choose}
        onOpenMap={openMap}
      />
      <AddressPicker open={mapOpen} onClose={closeMap} zones={zones} onChoose={chooseFromMap} />
      {live}
    </>
  );

  if (served === null) {
    return (
      <section aria-label={t.heading} data-testid="delivery-district" data-state="unset">
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setSheetOpen(true)}
          className={`flex w-full items-center gap-3 rounded-2xl bg-brand-soft p-3 text-left hover:bg-brand-soft/80 ${PRESS} ${FOCUS_RING}`}
        >
          <PinBadge />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base leading-6 font-semibold">{t.choosePrompt}</span>
            {staleChoice ? (
              <span className="text-sm leading-5 text-muted-foreground">
                {t.previousUnavailable}
              </span>
            ) : null}
          </span>
          <ChevronRightIcon aria-hidden="true" className="shrink-0 text-brand-ink" />
        </button>
        {overlays}
      </section>
    );
  }

  const name = districtName(served.district, locale);

  return (
    <section
      aria-labelledby="delivery-district-heading"
      data-testid="delivery-district"
      data-state="set"
      data-district={served.district.code}
      className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3"
    >
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
        onClick={() => setSheetOpen(true)}
        className={`${BUTTON} -mr-1 border border-border bg-surface text-foreground hover:bg-surface-muted`}
      >
        {t.change}
      </button>
      {overlays}
    </section>
  );
}

function PinBadge() {
  return (
    <span
      aria-hidden="true"
      className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-brand-ink ring-1 ring-border"
    >
      <PinIcon width={20} height={20} />
    </span>
  );
}

/** Every served district once, in the API's order (zones are pricing, not shown here). */
function servedDistricts(zones: readonly DeliveryZone[]): District[] {
  const seen = new Set<DistrictCode>();
  const out: District[] = [];
  for (const { districts } of districtGroups(zones)) {
    for (const district of districts) {
      if (seen.has(district.code)) continue;
      seen.add(district.code);
      out.push(district);
    }
  }
  return out;
}

interface DistrictSheetProps {
  open: boolean;
  onClose: () => void;
  zones: DeliveryZone[];
  current: DistrictCode | null;
  onChoose: (code: DistrictCode) => void;
  onOpenMap: () => void;
}

/**
 * The picker: an optional "Choose on the map" on top, then one radio group with every served
 * district and a "Choose" button that commits. Arrow keys move between districts without
 * committing (native radio behaviour), so a keyboard or screen-reader user can browse the list;
 * Escape, the backdrop and the close button leave the previous choice untouched.
 */
function DistrictSheet({ open, onClose, zones, current, onChoose, onOpenMap }: DistrictSheetProps) {
  const { dict, locale } = useI18n();
  const t = dict.delivery;
  const [pending, setPending] = useState<DistrictCode | null>(current);
  const [wasOpen, setWasOpen] = useState(open);
  // Every time the sheet opens it starts from the saved choice, not from an abandoned one.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPending(current);
  }

  const districts = servedDistricts(zones);
  const focusCode = pending ?? districts[0]?.code ?? null;

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
    <BottomSheet open={open} onClose={onClose} title={t.sheetTitle} closeLabel={t.close}>
      <form
        ref={formRef}
        data-testid="district-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending !== null) onChoose(pending);
        }}
        className="flex flex-col gap-4"
      >
        <button
          type="button"
          data-testid="open-map"
          onClick={onOpenMap}
          className={`flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 text-left hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
        >
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink"
          >
            <MapIcon width={20} height={20} />
          </span>
          <span className="min-w-0 flex-1 text-base font-medium">{dict.map.open}</span>
          <ChevronRightIcon aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </button>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">{t.districtsLegend}</legend>
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
                <span className="text-base font-medium [overflow-wrap:anywhere]">
                  {districtName(district, locale)}
                </span>
              </RadioCard>
            ))}
          </div>
        </fieldset>
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
