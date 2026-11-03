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
  /** Back / Escape / backdrop: nothing is marked. */
  onClose: () => void;
  /** "Mark this point". Receives nothing on purpose: the point never leaves the map. */
  onConfirm: () => void;
}

/**
 * Optional map step for choosing where to deliver. Mobile: an immersive full-height page; wide
 * screens: a centred panel. The map is Yandex Maps, loaded only now (see `yandex-loader.ts`); the
 * pin is drawn by the app at the map's centre and the customer moves the map under it.
 *
 * What this is not: the delivery address or a coverage check. The district list stays the real
 * choice and the checkout form stays the address. The picked point is never read out of the map,
 * so it cannot be stored, logged or sent anywhere; confirming only tells the parent "a point was
 * marked".
 *
 * Without a key, offline, or when the script fails, it shows its own fallback instead of a map
 * and the rest of the storefront is unaffected. Yandex's attribution and "Open in Yandex Maps"
 * links sit in the map's bottom corner; nothing of ours overlays that edge (the confirm bar is
 * below the map, not on it).
 */
export function AddressPicker({ open, onClose, onConfirm }: AddressPickerProps) {
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (open || !rendered) return undefined;
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  // Telegram: the native BackButton closes the picker and the MainButton (for example "Go to
  // cart") is hidden while it is open, so it never competes with "Mark this point".
  useBackButton({ visible: open, onClick: onClose });
  useSuppressMainButton(open);

  if (!rendered) return null;
  return <PickerPanel closing={!open} onClose={onClose} onConfirm={onConfirm} />;
}

interface PickerPanelProps {
  closing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function PickerPanel({ closing, onClose, onConfirm }: PickerPanelProps) {
  const { dict } = useI18n();
  const t = dict.map;
  const titleId = useId();
  const hintId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [maps, retry] = useYandexMaps(true);
  const ready = maps.status === 'ready';

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
            <button
              type="button"
              disabled={!ready}
              onClick={() => onConfirm()}
              className={`inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-6 text-base font-semibold text-primary-foreground enabled:hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS_RING}`}
            >
              {t.confirm}
            </button>
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
 * The live map. Holds the `YMap` instance in a ref; the centre is only ever read here, to pan by
 * keyboard, and handed straight back to the map.
 */
function MapStage({ api, hintId }: { api: YMaps3; hintId: string }) {
  const { dict } = useI18n();
  const t = dict.map;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<YMapInstance | null>(null);
  const [moving, setMoving] = useState(false);
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
    map.addChild(
      new api.YMapListener({
        onActionStart: () => setMoving(true),
        onActionEnd: () => setMoving(false),
        // A tap moves the map so the tapped spot comes under the pin.
        onClick: (_object, event) =>
          map.update({ location: { center: event.coordinates, zoom: map.zoom, duration: 200 } }),
      }),
    );
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
      {/* The pin: ours, centred, never interactive. Its tip marks the point; it lifts while the
          map moves and settles when it stops (transform only). */}
      <div
        aria-hidden="true"
        data-testid="map-pin"
        data-moving={moving}
        className="pointer-events-none absolute top-1/2 left-1/2"
      >
        <span className="absolute -top-1 -left-2 h-2 w-4 rounded-[50%] bg-black/25 transition-[transform,opacity] duration-150 ease-out-strong in-data-[moving=true]:scale-75 in-data-[moving=true]:opacity-60" />
        <svg
          viewBox="0 0 32 44"
          width="32"
          height="44"
          className="absolute -top-11 -left-4 text-primary drop-shadow-md transition-transform duration-150 ease-out-strong in-data-[moving=true]:-translate-y-2 motion-reduce:transition-none"
        >
          <path
            fill="currentColor"
            d="M16 1C7.7 1 1 7.6 1 15.8 1 26.6 16 43 16 43s15-16.4 15-27.2C31 7.6 24.3 1 16 1z"
          />
          <circle cx="16" cy="15.5" r="5.5" fill="var(--mm-color-primary-foreground, #fff)" />
        </svg>
      </div>
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
