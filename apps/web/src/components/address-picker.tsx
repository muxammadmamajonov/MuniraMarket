'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '@/i18n/context';
import { useYandexMaps } from '@/lib/maps/use-yandex-maps';
import type { LngLat, YMapInstance, YMaps3 } from '@/lib/maps/yandex-types';
import { useBackButton, useSuppressMainButton } from '@/lib/telegram';
import { ChevronLeftIcon, LocateIcon, MapIcon } from './icons';
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
  /** Back / Escape / backdrop / "Back to the list". */
  onClose: () => void;
}

/**
 * Optional map view from the address chooser, for orientation only. Mobile: an immersive
 * full-height page; wide screens: a centred panel. The map is Yandex Maps, loaded only now (see
 * `yandex-loader.ts`); the customer can pan, zoom and, on request, centre it on their location.
 *
 * It selects nothing. There is no pin and no "confirm": no point is read out of the map, stored,
 * sent or passed to checkout, and no Yandex geocoder or address data is used. The district list
 * is the delivery-coverage choice and the checkout form is the address. Storing a real point on
 * an order needs its own privacy, schema, consent and licence decision first.
 *
 * Without a key, offline, or when the script fails, it shows its own fallback instead of a map
 * and the rest of the storefront is unaffected. Yandex's attribution and "Open in Yandex Maps"
 * links sit in the map's bottom corner; nothing of ours overlays that edge (the bar with "Back to
 * the list" is below the map, not on it).
 */
export function AddressPicker({ open, onClose }: AddressPickerProps) {
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (open || !rendered) return undefined;
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  // Telegram: the native BackButton closes the map and the MainButton (for example "Go to cart")
  // is hidden while it is open, so it never sits under the map's own "Back to the list".
  useBackButton({ visible: open, onClick: onClose });
  useSuppressMainButton(open);

  if (!rendered) return null;
  return <PickerPanel closing={!open} onClose={onClose} />;
}

interface PickerPanelProps {
  closing: boolean;
  onClose: () => void;
}

function PickerPanel({ closing, onClose }: PickerPanelProps) {
  const { dict } = useI18n();
  const t = dict.map;
  const titleId = useId();
  const hintId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [maps, retry] = useYandexMaps(true);

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
    body = <MapStage api={maps.api} hintId={hintId} />;
  } else if (maps.status === 'missing-key') {
    body = (
      <StatePanel
        testId="map-unavailable"
        title={t.unavailableTitle}
        text={t.unavailableText}
        actions={<SecondaryButton onClick={onClose}>{t.backToList}</SecondaryButton>}
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
            <SecondaryButton onClick={onClose}>{t.backToList}</SecondaryButton>
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
        <span
          aria-hidden="true"
          className="size-6 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none"
        />
        {t.loading}
      </div>
    );
  }

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
          'md:h-[min(calc(100%-3rem),44rem)] md:max-w-3xl md:rounded-2xl md:shadow-xl ' +
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

        <div className="relative min-h-0 flex-1 bg-surface-muted">{body}</div>

        {maps.status === 'ready' || maps.status === 'loading' || maps.status === 'idle' ? (
          <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-background pt-3 pr-[max(1rem,var(--mm-inset-right))] pb-[calc(0.75rem+var(--mm-inset-bottom))] pl-[max(1rem,var(--mm-inset-left))] md:pb-3">
            <p id={hintId} className="text-sm leading-5 text-muted-foreground">
              {t.hint}
            </p>
            <PrimaryButton onClick={onClose}>{t.backToList}</PrimaryButton>
          </div>
        ) : null}
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

/**
 * The live map. Holds the `YMap` instance in a ref; its centre is only read here, to pan by
 * keyboard, and handed straight back to the map. Gestures are the SDK's own.
 */
function MapStage({ api, hintId }: { api: YMaps3; hintId: string }) {
  const { dict } = useI18n();
  const t = dict.map;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YMapInstance | null>(null);
  const [locate, setLocate] = useState<LocateState>('idle');
  const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator;

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
    mapRef.current = map;
    return () => {
      mapRef.current = null;
      map.destroy();
    };
  }, [api]);

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
  };

  const onLocate = () => {
    if (!canLocate || locate === 'locating') return;
    setLocate('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocate('idle');
        mapRef.current?.update({
          location: {
            center: [position.coords.longitude, position.coords.latitude],
            zoom: 16,
            duration: 200,
          },
        });
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
                : 'rounded-xl bg-background px-3 py-2 text-sm leading-5 shadow-md'
            }
          >
            {locateMessage}
          </p>
        </div>
      ) : null}
    </div>
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
      className={`inline-flex min-h-12 items-center justify-center rounded-xl bg-primary px-6 font-semibold text-primary-foreground hover:bg-primary-hover ${PRESS} ${FOCUS_RING}`}
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
      className={`inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-surface px-6 font-semibold text-foreground hover:bg-surface-muted ${PRESS} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}
