'use client';

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
import {
  ADDRESS_LIMITS,
  ADDRESS_TEXT_FIELDS,
  roundCoordinate,
  validateAddress,
  type Address,
  type AddressError,
  type AddressErrors,
  type AddressTextField,
} from '@/lib/address/address';
import { reverseGeocodeAddress } from '@/lib/maps/reverse-geocode';
import { useYandexMaps, useYandexMapsGeocoderApiKey } from '@/lib/maps/use-yandex-maps';
import type { LngLat, YMapInstance, YMaps3 } from '@/lib/maps/yandex-types';
import { useBackButton, useSuppressMainButton, useTelegram } from '@/lib/telegram';
import { FormField } from './form-field';
import { ChevronLeftIcon, LocateIcon, MapIcon, PinIcon } from './icons';
import { ERROR_TEXT, FOCUS_RING, INPUT, PRESS } from './ui-classes';

/** Tashkent city centre (Amir Temur square), `[lng, lat]`. Public, not anyone's location. */
export const TASHKENT_CENTER: LngLat = [69.2797, 41.3111];
const START_ZOOM = 12;
/** Zoom for a known point (a saved address or "My location"): a street and its houses. */
const POINT_ZOOM = 16;

/** Must match `duration-200` below; the picker stays mounted this long while it closes. */
const EXIT_MS = 200;
/** Quiet time after the map stops before its centre is looked up (a pan often comes in bursts). */
export const GEOCODE_DEBOUNCE_MS = 400;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface AddressPickerProps {
  open: boolean;
  /** Back / Escape / backdrop: closes without saving. */
  onClose: () => void;
  /** The address to edit (its point centres the map), or `null` for a new one. */
  initial: Address | null;
  /** "Deliver here" with a placed pin and a valid form. */
  onSave: (address: Address) => void;
}

/**
 * The delivery address chooser: the map and the address form on one screen, nothing in between.
 * Mobile: an immersive full-height page (map on top, form and actions below, the actions in thumb
 * reach); wide screens: a centred dialog with the map and a side panel. Reusable: the home card,
 * checkout and saved addresses all edit an {@link Address} with it.
 *
 * The customer moves the map under a fixed centre pin (or taps "My location", the only place
 * geolocation is ever requested). Each time the map comes to rest, its centre is reverse-geocoded
 * (`reverse-geocode.ts`) and street and house are filled in, so the customer mostly confirms.
 * "Deliver here" saves the pin and the form; it says nothing about areas, prices or fees.
 *
 * Without a key, offline, or when the script fails, it shows its own fallback instead of a map
 * (a point is required, so the address cannot be saved then). Yandex's attribution sits in the
 * map's bottom corner; nothing of ours overlays that edge.
 */
export function AddressPicker({ open, onClose, initial, onSave }: AddressPickerProps) {
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (open || !rendered) return undefined;
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  // Telegram: the native BackButton closes the picker and the MainButton (for example "Place
  // order") is hidden while it is open, so it never competes with "Deliver here".
  useBackButton({ visible: open, onClick: onClose });
  useSuppressMainButton(open);

  if (!rendered) return null;
  return <PickerPanel closing={!open} onClose={onClose} initial={initial} onSave={onSave} />;
}

type TextValues = Record<AddressTextField, string>;
type Lookup = 'idle' | 'looking' | 'failed';
type LocateState = 'idle' | 'locating' | 'denied' | 'unavailable';

function textValues(address: Address | null): TextValues {
  return {
    street: address?.street ?? '',
    house: address?.house ?? '',
    apartment: address?.apartment ?? '',
    entrance: address?.entrance ?? '',
    floor: address?.floor ?? '',
    landmark: address?.landmark ?? '',
  };
}

interface PickerPanelProps {
  closing: boolean;
  onClose: () => void;
  initial: Address | null;
  onSave: (address: Address) => void;
}

function PickerPanel({ closing, onClose, initial, onSave }: PickerPanelProps) {
  const { dict } = useI18n();
  const t = dict.map;
  const telegram = useTelegram();
  const titleId = useId();
  const hintId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YMapInstance | null>(null);
  const [maps, retry] = useYandexMaps(true);
  const geocoderApiKey = useYandexMapsGeocoderApiKey();
  const [values, setValues] = useState<TextValues>(() => textValues(initial));
  const [errors, setErrors] = useState<AddressErrors>({});
  // The pin counts as placed once the customer moved the map or located themselves (or edits a
  // saved address). Before that the map shows the city centre, which is nobody's address.
  const [placed, setPlaced] = useState(initial !== null);
  const [placeError, setPlaceError] = useState(false);
  const [lookup, setLookup] = useState<Lookup>('idle');
  const [locate, setLocate] = useState<LocateState>('idle');
  // Bumped whenever the map moves, so a lookup for an old point can never fill the form.
  const generation = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const nativeLocation = telegram.kind === 'telegram' ? telegram.webApp.LocationManager : undefined;
  const canLocate =
    nativeLocation !== undefined ||
    (typeof navigator !== 'undefined' && 'geolocation' in navigator);

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
      clearTimeout(debounce.current);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected)
        previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  /** Looks up the current centre and fills street and house (unless the map moved meanwhile). */
  const geocodeCentre = useCallback(async () => {
    const map = mapRef.current;
    if (map === null) return;
    const ticket = generation.current;
    if (geocoderApiKey === null) {
      setLookup('failed');
      return;
    }
    setLookup('looking');
    const point: LngLat = [map.center[0], map.center[1]];
    const found = await reverseGeocodeAddress(point, { apiKey: geocoderApiKey });
    if (ticket !== generation.current) return;
    if (found === null) {
      setLookup('failed');
      return;
    }
    setLookup('idle');
    setValues((current) => ({
      ...current,
      street:
        found.street === '' ? current.street : found.street.slice(0, ADDRESS_LIMITS.street.max),
      house: found.house.slice(0, ADDRESS_LIMITS.house.max),
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next.street;
      delete next.house;
      return next;
    });
  }, [geocoderApiKey]);

  const onMoveStart = useCallback(() => {
    generation.current += 1;
    clearTimeout(debounce.current);
  }, []);

  const onMoveEnd = useCallback(() => {
    generation.current += 1;
    setPlaced(true);
    setPlaceError(false);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void geocodeCentre(), GEOCODE_DEBOUNCE_MS);
  }, [geocodeCentre]);

  // Geolocation only on this explicit tap. The position re-centres the map; like any other move,
  // the new centre is then looked up.
  const onLocate = () => {
    if (!canLocate || locate === 'locating' || mapRef.current === null) return;
    setLocate('locating');
    const moveTo = (longitude: number, latitude: number) => {
      setLocate('idle');
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      onMoveStart();
      mapRef.current?.update({
        location: { center: [longitude, latitude], zoom: POINT_ZOOM, duration: reduce ? 0 : 200 },
      });
      onMoveEnd();
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
      (position) => moveTo(position.coords.longitude, position.coords.latitude),
      (error) => setLocate(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const setField = (field: AddressTextField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const save = () => {
    const map = mapRef.current;
    if (map === null || maps.status !== 'ready') return;
    if (!placed) {
      setPlaceError(true);
      panelRef.current
        ?.querySelector<HTMLElement>('[data-testid="map-canvas"]')
        ?.focus({ preventScroll: true });
      return;
    }
    const address: Address = {
      lat: roundCoordinate(map.center[1]),
      lon: roundCoordinate(map.center[0]),
      ...values,
    };
    const found = validateAddress(address);
    setErrors(found);
    const first = ADDRESS_TEXT_FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      panelRef.current
        ?.querySelector<HTMLElement>(`[name="address-${first}"]`)
        ?.focus({ preventScroll: false });
      return;
    }
    onSave({
      ...address,
      ...Object.fromEntries(ADDRESS_TEXT_FIELDS.map((field) => [field, address[field].trim()])),
    } as Address);
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

  const start: { center: LngLat; zoom: number } =
    initial === null
      ? { center: TASHKENT_CENTER, zoom: START_ZOOM }
      : { center: [initial.lon, initial.lat], zoom: POINT_ZOOM };

  let mapBody: ReactNode;
  if (maps.status === 'ready') {
    mapBody = (
      <MapStage
        api={maps.api}
        start={start}
        hintId={hintId}
        mapRef={mapRef}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
      />
    );
  } else if (maps.status === 'missing-key') {
    mapBody = (
      <StatePanel
        testId="map-unavailable"
        title={t.unavailableTitle}
        text={t.unavailableText}
        actions={<PrimaryButton onClick={onClose}>{t.close}</PrimaryButton>}
      />
    );
  } else if (maps.status === 'error') {
    mapBody = (
      <StatePanel
        testId="map-error"
        title={maps.kind === 'offline' ? t.offlineTitle : t.errorTitle}
        text={t.errorText}
        actions={<PrimaryButton onClick={retry}>{t.retry}</PrimaryButton>}
      />
    );
  } else {
    mapBody = (
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

  const showForm = maps.status === 'ready' || maps.status === 'loading' || maps.status === 'idle';

  const statusText =
    locate === 'denied'
      ? t.locationDenied
      : locate === 'unavailable'
        ? t.locationUnavailable
        : locate === 'locating'
          ? t.locating
          : lookup === 'looking'
            ? t.geocoding
            : lookup === 'failed'
              ? t.geocodeFailed
              : t.hint;

  const errorText = (error: AddressError | undefined): string | undefined => {
    if (error === undefined) return undefined;
    const e = dict.checkout.errors;
    switch (error.kind) {
      case 'required':
        return e.required;
      case 'tooShort':
        return formatMessage(e.tooShort, { min: error.limit ?? 0 });
      case 'tooLong':
        return formatMessage(e.tooLong, { max: error.limit ?? 0 });
      case 'singleLine':
        return e.singleLine;
    }
  };

  const field = (
    name: AddressTextField,
    config: {
      label: string;
      optional?: boolean;
      placeholder?: string;
      inputMode?: 'text' | 'numeric';
      /** A short field in a row of three: no "optional" marker (it would wrap at 320px). */
      compact?: boolean;
    },
  ) => (
    <FormField
      label={config.label}
      {...(config.optional === true && config.compact !== true
        ? { optionalLabel: t.optional }
        : {})}
      error={errorText(errors[name])}
      required={config.optional !== true}
    >
      {(control) => (
        <input
          {...control}
          name={`address-${name}`}
          type="text"
          inputMode={config.inputMode ?? 'text'}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="next"
          maxLength={ADDRESS_LIMITS[name].max}
          value={values[name]}
          {...(config.placeholder === undefined ? {} : { placeholder: config.placeholder })}
          onChange={(event) => setField(name, event.target.value)}
          data-user-text=""
          className={INPUT}
        />
      )}
    </FormField>
  );

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
          <div className="relative min-h-[32dvh] flex-1 bg-surface-muted">{mapBody}</div>

          {showForm ? (
            <form
              noValidate
              aria-labelledby={titleId}
              data-testid="address-form"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              className="flex max-h-[58dvh] shrink-0 flex-col border-t border-border bg-background md:max-h-none md:w-96 md:border-t-0 md:border-l"
            >
              <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain pt-3 pr-[max(1rem,var(--mm-inset-right))] pb-3 pl-[max(1rem,var(--mm-inset-left))] md:pt-4">
                <p
                  id={hintId}
                  role="status"
                  data-testid="map-status"
                  data-lookup={lookup}
                  className="text-sm leading-5 text-muted-foreground"
                >
                  {statusText}
                </p>
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
                  {field('street', { label: t.street })}
                  {field('house', { label: t.house })}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {field('apartment', { label: t.apartment, optional: true, compact: true })}
                  {field('entrance', {
                    label: t.entrance,
                    optional: true,
                    compact: true,
                    inputMode: 'numeric',
                  })}
                  {field('floor', {
                    label: t.floor,
                    optional: true,
                    compact: true,
                    inputMode: 'numeric',
                  })}
                </div>
                {field('landmark', {
                  label: t.landmark,
                  optional: true,
                  placeholder: t.landmarkPlaceholder,
                })}
              </div>

              {/* The actions stay at the bottom edge, in thumb reach, while the fields scroll. */}
              <div
                data-testid="map-actions"
                className="flex shrink-0 flex-col gap-2 border-t border-border bg-background pt-3 pr-[max(1rem,var(--mm-inset-right))] pb-[calc(0.75rem+var(--mm-inset-bottom))] pl-[max(1rem,var(--mm-inset-left))] md:pb-4"
              >
                {placeError ? (
                  <p role="alert" data-testid="map-place-pin" className={ERROR_TEXT}>
                    {t.placePin}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2 min-[400px]:flex-row">
                  {canLocate ? (
                    <button
                      type="button"
                      data-testid="map-locate"
                      onClick={onLocate}
                      disabled={maps.status !== 'ready'}
                      aria-busy={locate === 'locating' || undefined}
                      className={`inline-flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-2xl bg-surface-muted px-4 font-semibold text-foreground enabled:hover:bg-border disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
                    >
                      {locate === 'locating' ? (
                        <Spinner small />
                      ) : (
                        <LocateIcon
                          width={20}
                          height={20}
                          className="shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{t.myLocation}</span>
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    data-testid="map-confirm"
                    disabled={maps.status !== 'ready'}
                    className={`inline-flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-2xl bg-primary px-5 min-[400px]:flex-1 text-center font-semibold text-primary-foreground enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
                  >
                    {t.deliverHere}
                  </button>
                </div>
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Screen pixels one arrow-key press pans the map by. */
const PAN_PX = 96;

/** Degrees per screen pixel at `zoom` (Web Mercator, 256px tiles), for keyboard panning. */
function degreesPerPixel(zoom: number): number {
  return 360 / (256 * 2 ** zoom);
}

interface MapStageProps {
  api: YMaps3;
  start: { center: LngLat; zoom: number };
  hintId: string;
  mapRef: RefObject<YMapInstance | null>;
  /** A gesture or keyboard move began: any lookup in flight is now stale. */
  onMoveStart: () => void;
  /** The map came to rest at a new centre. */
  onMoveEnd: () => void;
}

/**
 * The live map with the centre pin. Holds the `YMap` instance in `mapRef`; its centre is the
 * delivery point. Gestures are the SDK's own; arrow keys pan and +/- zoom.
 */
function MapStage({ api, start, hintId, mapRef, onMoveStart, onMoveEnd }: MapStageProps) {
  const { dict } = useI18n();
  const t = dict.map;
  const containerRef = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(false);
  const handlers = useRef({ onMoveStart, onMoveEnd });
  useEffect(() => {
    handlers.current = { onMoveStart, onMoveEnd };
  }, [onMoveStart, onMoveEnd]);
  // The starting view is read once, when the map is created.
  const startRef = useRef(start);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return undefined;
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const map = new api.YMap(element, {
      location: startRef.current,
      theme: dark ? 'dark' : 'light',
    });
    map.addChild(new api.YMapDefaultSchemeLayer({}));
    map.addChild(new api.YMapDefaultFeaturesLayer({}));
    if (api.YMapListener !== undefined) {
      map.addChild(
        new api.YMapListener({
          onActionStart: () => {
            setMoving(true);
            handlers.current.onMoveStart();
          },
          onActionEnd: () => {
            setMoving(false);
            handlers.current.onMoveEnd();
          },
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
    onMoveStart();
    map.update({ location: { center: [lng + move[0], lat + move[1]], zoom, duration: 0 } });
    onMoveEnd();
  };

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
    </div>
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

function PrimaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-center font-semibold text-primary-foreground hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}
