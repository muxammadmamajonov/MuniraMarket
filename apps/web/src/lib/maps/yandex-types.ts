/**
 * Minimal typings for the parts of the Yandex Maps JavaScript API v3 (`window.ymaps3`) that the
 * picker uses. Reference: https://yandex.com/maps-api/docs/js-api/ref/index.html
 *
 * Coordinates are `[longitude, latitude]`. The picker keeps them in React state only; the one
 * place a point leaves the browser is the reverse-geocoding request to Yandex itself (`search`),
 * after the customer pressed "Deliver here". Nothing here is stored, logged or sent to our API.
 */

export type LngLat = [number, number];

export interface YMapLocationRequest {
  center: LngLat;
  zoom: number;
  /** Animation length in ms; 0 for an instant jump. */
  duration?: number;
}

export type YMapEntity = object;

export interface YMapInstance {
  readonly center: LngLat;
  readonly zoom: number;
  addChild(child: YMapEntity): YMapInstance;
  update(props: { location?: YMapLocationRequest; theme?: 'light' | 'dark' }): void;
  destroy(): void;
}

export interface YMapProps {
  location: YMapLocationRequest;
  theme?: 'light' | 'dark';
}

/** `YMapListener` props: gesture start / end (`onActionStart` fires for drags, wheel and pinch). */
export interface YMapListenerProps {
  onActionStart?: () => void;
  onActionEnd?: () => void;
}

/** `ymaps3.search` options (subset). `text` may be a `"lng,lat"` point for reverse geocoding. */
export interface YSearchOptions {
  text?: string;
  type?: Array<'businesses' | 'toponyms'>;
  limit?: number;
}

export interface YSearchFeature {
  properties: { name: string; description: string };
  geometry?: { type: 'Point'; coordinates: LngLat };
}

export interface YConfig {
  setApikeys(keys: { search?: string; suggest?: string; router?: string }): void;
}

export interface YMaps3 {
  readonly ready: Promise<void>;
  YMap: new (element: HTMLElement, props: YMapProps) => YMapInstance;
  YMapDefaultSchemeLayer: new (props?: object) => YMapEntity;
  YMapDefaultFeaturesLayer: new (props?: object) => YMapEntity;
  /** Present in the v3 core; optional here so an older/partial SDK degrades to the fallback. */
  YMapListener?: new (props: YMapListenerProps) => YMapEntity;
  /** Geosearch (forward and reverse). Needs a Search API key (see `lib/maps/README.md`). */
  search?: (options: YSearchOptions) => Promise<YSearchFeature[]>;
  getDefaultConfig?: () => YConfig;
}

declare global {
  interface Window {
    ymaps3?: YMaps3;
  }
}
