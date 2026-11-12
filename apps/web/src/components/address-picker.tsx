'use client';

import type { DeliveryZone, District, DistrictCode } from '@muniramarket/contracts';
import { formatUZS } from '@muniramarket/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { districtName, zoneHours, zoneName } from '@/lib/checkout/zones';
import { coverageFor, isDemoZone, type Coverage } from '@/lib/delivery/coverage';
import { districtLabel } from '@/lib/delivery/districts';
import { reverseGeocodeDistrict } from '@/lib/maps/reverse-geocode';
import { useYandexMaps, useYandexMapsGeocoderApiKey } from '@/lib/maps/use-yandex-maps';
import type { LngLat, YMapInstance, YMaps3 } from '@/lib/maps/yandex-types';
import { useBackButton, useSuppressMainButton, useTelegram } from '@/lib/telegram';
import { ChevronLeftIcon, LocateIcon, MapIcon, PinIcon } from './icons';
import { FOCUS_RING, PRESS } from './ui-classes';

/** Tashkent city centre (Amir Temur square), `[lng, lat]`. Public, not anyone's location. */
export const TASHKENT_CENTER: LngLat = [69.2797, 41.3111];
const START_ZOOM = 12;

/** Must match `duration-200` below; the picker stays mounted this long while it closes. */
const EXIT_MS = 200;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface AddressPickerProps {
  open: boolean;
  /** Back / Escape / backdrop / "Choose from the list": returns to the district list. */
  onClose: () => void;
  /** Active zones (the source of truth for "we deliver here"). */
  zones: readonly DeliveryZone[];
  /** The customer chose a served district from a map result. Only the code leaves the picker. */
  onChoose: (code: DistrictCode) => void;
}

/**
 * The map step of the delivery chooser. Mobile: an immersive full-height page; wide screens: a
 * centred dialog with the map and a side panel. The map is Yandex Maps, loaded only now (see
 * `yandex-loader.ts`).
 *
 * The customer moves the map under a fixed centre pin (or taps "My location", the only place
 * geolocation is ever requested) and confirms with "Deliver here". Only then is the point used:
 * it is reverse-geocoded by Yandex (`reverse-geocode.ts`) to a Tashkent district, and the district
 * is checked against the live zones (`coverage.ts`). The result is honest: a served district with
 * its zone's real fee, minimum, free-delivery threshold and hours; a known but unserved district
 * with served neighbours; "outside Tashkent"; or, whenever the lookup is unavailable or unsure,
 * a request to pick the district from the list. It never says "we deliver here" on a guess.
 *
 * The point lives in the `YMap` instance and one function call; it is not kept in state, stored,
 * logged, put in a URL or sent to our API. Choosing a result saves only the district code.
 *
 * Without a key, offline, or when the script fails, it shows its own fallback instead of a map.
 * Yandex's attribution sits in the map's bottom corner; nothing of ours overlays that edge.
 */
export function AddressPicker({ open, onClose, zones, onChoose }: AddressPickerProps) {
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (open || !rendered) return undefined;
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  // Telegram: the native BackButton closes the map and the MainButton (for example "Go to cart")
  // is hidden while it is open, so it never competes with "Deliver here".
  useBackButton({ visible: open, onClick: onClose });
  useSuppressMainButton(open);

  if (!rendered) return null;
  return <PickerPanel closing={!open} onClose={onClose} zones={zones} onChoose={onChoose} />;
}

type Check = { phase: 'pick' } | { phase: 'checking' } | { phase: 'result'; coverage: Coverage };

interface PickerPanelProps {
  closing: boolean;
  onClose: () => void;
  zones: readonly DeliveryZone[];
  onChoose: (code: DistrictCode) => void;
}

function PickerPanel({ closing, onClose, zones, onChoose }: PickerPanelProps) {
  const { dict } = useI18n();
  const t = dict.map;
  const titleId = useId();
  const hintId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YMapInstance | null>(null);
  const [maps, retry] = useYandexMaps(true);
  const geocoderApiKey = useYandexMapsGeocoderApiKey();
  const [check, setCheck] = useState<Check>({ phase: 'pick' });
  // Bumped whenever the map moves, so a lookup for an old point can never show its result.
  const generation = useRef(0);

  // Focus the back button on open and return focus on close; lock the page behind.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    panelRef.current
      ?.querySelector<HTMLElement>('[data-autofocus]')
      ?.focus({ preventScroll: true });
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected)
        previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  const onMapMoved = useCallback(() => {
    generation.current += 1;
    setCheck((current) => (current.phase === 'pick' ? current : { phase: 'pick' }));
  }, []);

  const checkPoint = async () => {
    const map = mapRef.current;
    if (map === null || maps.status !== 'ready' || check.phase === 'checking') return;
    const ticket = ++generation.current;
    setCheck({ phase: 'checking' });
    const point: LngLat = [map.center[0], map.center[1]];
    const match =
      geocoderApiKey === null
        ? null
        : await reverseGeocodeDistrict(point, { apiKey: geocoderApiKey });
    if (ticket !== generation.current) return;
    setCheck({ phase: 'result', coverage: coverageFor(zones, match, point) });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  let body: ReactNode;
  if (maps.status === 'ready') {
    body = (
      <MapStage
        api={maps.api}
        hintId={hintId}
        mapRef={mapRef}
        onMoved={onMapMoved}
        dimmed={check.phase !== 'pick'}
      />
    );
  } else if (maps.status === 'missing-key') {
    body = (
      <StatePanel
        testId="map-unavailable"
        title={t.unavailableTitle}
        text={t.unavailableText}
        actions={<PrimaryButton onClick={onClose}>{t.pickFromList}</PrimaryButton>}
      />
    );
  } else if (maps.status === 'error') {
    body = (
      <StatePanel
        testId="map-error"
        title={maps.kind === 'offline' ? t.offlineTitle : t.errorTitle}
        text={t.errorText}
        actions={
          <>
            <PrimaryButton onClick={retry}>{t.retry}</PrimaryButton>
            <SecondaryButton onClick={onClose}>{t.pickFromList}</SecondaryButton>
          </>
        }
      />
    );
  } else {
    body = (
      <div
        role="status"
        data-testid="map-loading"
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
      >
        <Spinner />
        {t.loading}
      </div>
    );
  }

  const showActions =
    maps.status === 'ready' || maps.status === 'loading' || maps.status === 'idle';

  return (
    <div
      data-testid="address-picker"
      data-closing={closing}
      onKeyDown={onKeyDown}
      className={
        'fixed inset-0 z-50 flex md:items-center md:justify-center md:px-6 ' +
        'md:pt-(--mm-inset-top) md:pb-(--mm-inset-bottom) ' +
        (closing ? 'pointer-events-none' : '')
      }
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        data-closing={closing}
        className="absolute inset-0 hidden bg-black/50 opacity-100 transition-opacity duration-200 ease-out-strong starting:opacity-0 data-[closing=true]:opacity-0 md:block"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-closing={closing}
        className={
          'relative flex h-dvh w-full flex-col overflow-hidden bg-background ' +
          'md:h-[min(calc(100%-3rem),44rem)] md:max-w-4xl md:rounded-2xl md:shadow-xl ' +
          // Mobile: slides up like a page; wide screens: a quick fade with a hint of scale.
          'transform-[translateY(0)] opacity-100 transition-[transform,opacity] duration-200 ease-drawer ' +
          'starting:transform-[translateY(100%)] data-[closing=true]:transform-[translateY(100%)] ' +
          'md:starting:transform-[scale(0.98)] md:data-[closing=true]:transform-[scale(0.98)] ' +
          'md:starting:opacity-0 md:data-[closing=true]:opacity-0 ' +
          'motion-reduce:transform-none motion-reduce:starting:transform-none ' +
          'motion-reduce:data-[closing=true]:transform-none'
        }
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background pt-[calc(var(--mm-inset-top)+0.375rem)] pr-[max(1rem,var(--mm-inset-right))] pb-1.5 pl-[max(0.5rem,var(--mm-inset-left))] md:pt-1.5">
          <button
            type="button"
            data-autofocus
            aria-label={t.close}
            onClick={onClose}
            className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
          >
            <ChevronLeftIcon />
          </button>
          <h2 id={titleId} className="min-w-0 truncate text-base font-semibold">
            {t.title}
          </h2>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="relative min-h-0 flex-1 bg-surface-muted">{body}</div>

          {showActions ? (
            <div
              data-testid="map-actions"
              className="flex max-h-[60dvh] shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain border-t border-border bg-background pt-3 pr-[max(1rem,var(--mm-inset-right))] pb-[calc(0.75rem+var(--mm-inset-bottom))] pl-[max(1rem,var(--mm-inset-left))] md:max-h-none md:w-80 md:border-t-0 md:border-l md:pt-4 md:pb-4"
            >
              {check.phase === 'result' ? (
                <ResultPanel
                  coverage={check.coverage}
                  onChoose={onChoose}
                  onMovePin={() => {
                    onMapMoved();
                    panelRef.current
                      ?.querySelector<HTMLElement>('[data-testid="map-canvas"]')
                      ?.focus({ preventScroll: true });
                  }}
                  onPickFromList={onClose}
                />
              ) : (
                <>
                  <p id={hintId} className="text-sm leading-5 text-muted-foreground">
                    {t.hint}
                  </p>
                  <PrimaryButton
                    testId="map-confirm"
                    onClick={() => void checkPoint()}
                    busy={check.phase === 'checking'}
                    disabled={maps.status !== 'ready'}
                  >
                    {check.phase === 'checking' ? (
                      <>
                        <Spinner small />
                        {t.checking}
                      </>
                    ) : (
                      t.deliverHere
                    )}
                  </PrimaryButton>
                  <SecondaryButton onClick={onClose}>{t.pickFromList}</SecondaryButton>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type LocateState = 'idle' | 'locating' | 'denied' | 'unavailable';

/** Screen pixels one arrow-key press pans the map by. */
const PAN_PX = 96;

/** Degrees per screen pixel at `zoom` (Web Mercator, 256px tiles), for keyboard panning. */
function degreesPerPixel(zoom: number): number {
  return 360 / (256 * 2 ** zoom);
}

interface MapStageProps {
  api: YMaps3;
  hintId: string;
  mapRef: RefObject<YMapInstance | null>;
  /** The map moved (gesture, keyboard or "My location"): any result is now stale. */
  onMoved: () => void;
  /** A lookup or result is showing: the pin settles, nothing else changes. */
  dimmed: boolean;
}

/**
 * The live map with the centre pin. Holds the `YMap` instance in `mapRef`; its centre is read only
 * to pan by keyboard and, on "Deliver here", for the one lookup. Gestures are the SDK's own.
 */
function MapStage({ api, hintId, mapRef, onMoved, dimmed }: MapStageProps) {
  const { dict } = useI18n();
  const t = dict.map;
  const telegram = useTelegram();
  const containerRef = useRef<HTMLDivElement>(null);
  const [locate, setLocate] = useState<LocateState>('idle');
  const [moving, setMoving] = useState(false);
  const nativeLocation = telegram.kind === 'telegram' ? telegram.webApp.LocationManager : undefined;
  const canLocate =
    nativeLocation !== undefined ||
    (typeof navigator !== 'undefined' && 'geolocation' in navigator);
  const onMovedRef = useRef(onMoved);
  useEffect(() => {
    onMovedRef.current = onMoved;
  }, [onMoved]);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return undefined;
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const map = new api.YMap(element, {
      location: { center: TASHKENT_CENTER, zoom: START_ZOOM },
      theme: dark ? 'dark' : 'light',
    });
    map.addChild(new api.YMapDefaultSchemeLayer({}));
    map.addChild(new api.YMapDefaultFeaturesLayer({}));
    if (api.YMapListener !== undefined) {
      map.addChild(
        new api.YMapListener({
          onActionStart: () => {
            setMoving(true);
            onMovedRef.current();
          },
          onActionEnd: () => setMoving(false),
        }),
      );
    }
    mapRef.current = map;
    return () => {
      mapRef.current = null;
      map.destroy();
    };
  }, [api, mapRef]);

  // Arrow keys pan, +/- zoom. Instant: keyboard steps repeat and must never queue animations.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const map = mapRef.current;
    if (map === null) return;
    const [lng, lat] = map.center;
    const step = PAN_PX * degreesPerPixel(map.zoom);
    const moves: Record<string, [number, number, number]> = {
      ArrowUp: [0, step, 0],
      ArrowDown: [0, -step, 0],
      ArrowLeft: [-step, 0, 0],
      ArrowRight: [step, 0, 0],
      '+': [0, 0, 1],
      '=': [0, 0, 1],
      '-': [0, 0, -1],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const zoom = Math.min(19, Math.max(3, map.zoom + move[2]));
    map.update({ location: { center: [lng + move[0], lat + move[1]], zoom, duration: 0 } });
    onMoved();
  };

  // Geolocation only on this explicit tap. The position only re-centres the map; it is used for
  // delivery only once the customer presses "Deliver here".
  const onLocate = () => {
    if (!canLocate || locate === 'locating') return;
    setLocate('locating');
    const moveTo = (longitude: number, latitude: number) => {
      setLocate('idle');
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      mapRef.current?.update({
        location: { center: [longitude, latitude], zoom: 16, duration: reduce ? 0 : 200 },
      });
      onMoved();
    };

    // Telegram's native manager is the source of truth inside a Mini App. Browser geolocation is
    // only the fallback for normal browsers and older Telegram clients that do not have it.
    if (nativeLocation !== undefined) {
      nativeLocation.init(() => {
        if (!nativeLocation.isLocationAvailable) {
          setLocate('unavailable');
          return;
        }
        nativeLocation.getLocation((position) => {
          if (position === null) {
            setLocate(nativeLocation.isAccessGranted ? 'unavailable' : 'denied');
            return;
          }
          moveTo(position.longitude, position.latitude);
        });
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        moveTo(position.coords.longitude, position.coords.latitude);
      },
      (error) => setLocate(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const locateMessage =
    locate === 'denied'
      ? t.locationDenied
      : locate === 'unavailable'
        ? t.locationUnavailable
        : locate === 'locating'
          ? t.locating
          : '';

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        data-testid="map-canvas"
        role="application"
        tabIndex={0}
        aria-label={t.canvasLabel}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        className="absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      />
      {/* The pin is ours, fixed at the centre; the map moves beneath it. Its tip is the point. */}
      <div
        data-testid="map-pin"
        role="img"
        aria-label={t.pinLabel}
        data-moving={moving}
        data-dimmed={dimmed}
        className="pointer-events-none absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-full flex-col items-center text-primary transition-transform duration-150 ease-out-strong data-[moving=true]:-translate-y-[calc(100%+0.375rem)] motion-reduce:transition-none"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-2 ring-background">
          <PinIcon width={22} height={22} aria-hidden="true" />
        </span>
        <span aria-hidden="true" className="h-3 w-0.5 rounded-full bg-primary" />
      </div>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/60"
      />
      {canLocate ? (
        <div className="absolute top-3 right-[max(0.75rem,var(--mm-inset-right))] flex max-w-[calc(100%-1.5rem)] flex-col items-end gap-2">
          <button
            type="button"
            onClick={onLocate}
            aria-busy={locate === 'locating'}
            className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-background px-3 text-sm font-semibold shadow-md hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
          >
            <LocateIcon width={20} height={20} className="shrink-0" />
            <span className="truncate">{t.myLocation}</span>
          </button>
          <p
            role="status"
            data-testid="map-locate-status"
            className={
              locateMessage === ''
                ? 'sr-only'
                : 'max-w-72 rounded-xl bg-background px-3 py-2 text-sm leading-5 shadow-md'
            }
          >
            {locateMessage}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface ResultPanelProps {
  coverage: Coverage;
  onChoose: (code: DistrictCode) => void;
  onMovePin: () => void;
  onPickFromList: () => void;
}

/** The honest outcome of one confirmed point. Focus moves to its heading when it appears. */
function ResultPanel({ coverage, onChoose, onMovePin, onPickFromList }: ResultPanelProps) {
  const { dict, locale } = useI18n();
  const t = dict.map;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [coverage]);

  const heading = (text: string) => (
    <h3
      ref={headingRef}
      tabIndex={-1}
      className="text-base leading-6 font-semibold outline-none [overflow-wrap:anywhere]"
    >
      {text}
    </h3>
  );
  const movePin = <SecondaryButton onClick={onMovePin}>{t.movePin}</SecondaryButton>;
  const pickFromList = (primary: boolean) =>
    primary ? (
      <PrimaryButton onClick={onPickFromList}>{t.pickFromList}</PrimaryButton>
    ) : (
      <SecondaryButton onClick={onPickFromList}>{t.pickFromList}</SecondaryButton>
    );

  let content: ReactNode;
  switch (coverage.status) {
    case 'served': {
      const { zone, district } = coverage;
      const name = districtName(district, locale);
      const threshold = zone.free_delivery_threshold_uzs;
      content = (
        <>
          {heading(formatMessage(t.servedTitle, { district: name }))}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm leading-5">
            <Fact label={t.zoneLabel}>
              <span className="[overflow-wrap:anywhere]">{zoneName(zone, locale)}</span>
              {isDemoZone(zone) ? (
                <span
                  data-testid="demo-badge"
                  className="ml-1.5 inline-flex rounded-md bg-surface-muted px-1.5 text-xs leading-5 font-semibold whitespace-nowrap text-muted-foreground ring-1 ring-border"
                >
                  {t.demoBadge}
                </span>
              ) : null}
            </Fact>
            <Fact label={t.feeLabel}>
              {zone.delivery_fee_uzs === 0 ? t.free : formatUZS(zone.delivery_fee_uzs, locale)}
            </Fact>
            <Fact label={t.minOrderLabel}>{formatUZS(zone.min_order_uzs, locale)}</Fact>
            <Fact label={t.freeLabel}>
              {threshold === null
                ? t.freeNever
                : formatMessage(t.freeFrom, { amount: formatUZS(threshold, locale) })}
            </Fact>
            <Fact label={t.hoursLabel}>
              <span className="tabular-nums">{zoneHours(zone)}</span>
              <span className="text-muted-foreground">
                {', '}
                {zone.is_open_now ? t.openNow : t.closedNow}
              </span>
            </Fact>
          </dl>
          {isDemoZone(zone) ? (
            <p data-testid="demo-note" className="text-xs leading-4 text-muted-foreground">
              {t.demoNote}
            </p>
          ) : null}
          <p className="text-sm leading-5 text-muted-foreground">{t.addressLater}</p>
          <PrimaryButton testId="map-choose" onClick={() => onChoose(district.code)}>
            {formatMessage(t.chooseDistrict, { district: name })}
          </PrimaryButton>
          {movePin}
        </>
      );
      break;
    }
    case 'not-served': {
      const name = districtLabel(coverage.code, locale);
      content = (
        <>
          {heading(formatMessage(t.notServedTitle, { district: name }))}
          {coverage.nearby.length > 0 ? (
            <>
              <p className="text-sm leading-5 text-muted-foreground">{t.notServedNearby}</p>
              <NearbyList districts={coverage.nearby} onChoose={onChoose} />
            </>
          ) : (
            <p className="text-sm leading-5 text-muted-foreground">{t.notServedNoNearby}</p>
          )}
          {movePin}
          {pickFromList(false)}
        </>
      );
      break;
    }
    case 'outside':
      content = (
        <>
          {heading(t.outsideTitle)}
          <p className="text-sm leading-5 text-muted-foreground">{t.outsideText}</p>
          {movePin}
          {pickFromList(false)}
        </>
      );
      break;
    case 'unknown':
    case 'lookup-failed':
      content = (
        <>
          {heading(coverage.status === 'unknown' ? t.unknownTitle : t.lookupFailedTitle)}
          <p className="text-sm leading-5 text-muted-foreground">
            {coverage.status === 'unknown' ? t.unknownText : t.lookupFailedText}
          </p>
          {pickFromList(true)}
          {movePin}
        </>
      );
      break;
  }

  return (
    <div
      role="status"
      data-testid="map-result"
      data-status={coverage.status}
      className="flex flex-col gap-3"
    >
      {content}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </>
  );
}

function NearbyList({
  districts,
  onChoose,
}: {
  districts: readonly District[];
  onChoose: (code: DistrictCode) => void;
}) {
  const { locale } = useI18n();
  return (
    <ul className="flex flex-wrap gap-2">
      {districts.map((district) => (
        <li key={district.code}>
          <button
            type="button"
            onClick={() => onChoose(district.code)}
            className={`inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
          >
            {districtName(district, locale)}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Spinner({ small = false }: { small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`${small ? 'size-4' : 'size-6'} shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current motion-reduce:animate-none`}
    />
  );
}

function StatePanel({
  testId,
  title,
  text,
  actions,
}: {
  testId: string;
  title: string;
  text: string;
  actions: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-8 text-center"
    >
      <span
        aria-hidden="true"
        className="flex size-16 items-center justify-center rounded-2xl bg-brand-soft text-brand-ink"
      >
        <MapIcon width={30} height={30} />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p role="status" className="text-base font-semibold">
          {title}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">{text}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">{actions}</div>
    </div>
  );
}

interface ButtonProps {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  /** Working: stays focusable and announced, ignores presses (`aria-disabled`). */
  busy?: boolean;
  disabled?: boolean;
}

function PrimaryButton({ onClick, children, testId, busy = false, disabled = false }: ButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={busy ? undefined : onClick}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      disabled={disabled}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-center font-semibold text-primary-foreground enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress ${PRESS} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-surface px-6 text-center font-semibold text-foreground hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}
