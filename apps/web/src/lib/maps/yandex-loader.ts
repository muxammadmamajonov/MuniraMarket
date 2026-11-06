import type { Locale } from '@muniramarket/contracts';
import { YANDEX_MAPS_API_ORIGIN } from './config';
import type { YMaps3 } from './yandex-types';

/**
 * Loads the Yandex Maps JavaScript API on demand: only when the customer opens the map picker,
 * never on page load. One script tag at most; concurrent callers share the same promise. A failed
 * load removes its script tag and forgets the promise, so "Try again" really tries again.
 *
 * The script is injected by the app's own (nonce-trusted) bundle, which `'strict-dynamic'` in the
 * CSP allows; `connect-src` only lists the Yandex hosts when a key is configured (see `csp.ts`).
 */

export type MapsLoadErrorKind = 'offline' | 'script' | 'timeout';

export class MapsLoadError extends Error {
  readonly kind: MapsLoadErrorKind;

  constructor(kind: MapsLoadErrorKind) {
    super(`Yandex Maps failed to load (${kind}).`);
    this.name = 'MapsLoadError';
    this.kind = kind;
  }
}

const LANGS: Record<Locale, string> = { uz: 'uz_UZ', ru: 'ru_RU' };

export const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

export function yandexMapsScriptUrl(apiKey: string, locale: Locale): string {
  const url = new URL('/v3/', YANDEX_MAPS_API_ORIGIN);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('lang', LANGS[locale]);
  return url.toString();
}

let pending: Promise<YMaps3> | null = null;

export interface LoadYandexMapsOptions {
  apiKey: string;
  locale: Locale;
  timeoutMs?: number;
}

export function loadYandexMaps({
  apiKey,
  locale,
  timeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
}: LoadYandexMapsOptions): Promise<YMaps3> {
  if (pending !== null) return pending;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.reject(new MapsLoadError('offline'));
  }

  const attempt = new Promise<YMaps3>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = yandexMapsScriptUrl(apiKey, locale);
    script.async = true;
    script.dataset['mmYandexMaps'] = '';
    let settled = false;

    const fail = (kind: MapsLoadErrorKind) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      pending = null;
      reject(new MapsLoadError(kind));
    };
    const timer = setTimeout(() => fail('timeout'), timeoutMs);

    script.addEventListener('load', () => {
      const api = window.ymaps3;
      if (api === undefined) {
        fail('script');
        return;
      }
      api.ready.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(api);
        },
        () => fail('script'),
      );
    });
    script.addEventListener('error', () => fail(navigator.onLine === false ? 'offline' : 'script'));
    document.head.append(script);
  });
  pending = attempt;
  return attempt;
}

/** Test hook: forget the shared promise and any injected script. */
export function resetYandexMapsLoader(): void {
  pending = null;
  for (const script of document.querySelectorAll('script[data-mm-yandex-maps]')) script.remove();
}
