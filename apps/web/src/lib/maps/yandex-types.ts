/**
 * Minimal typings for the parts of the Yandex Maps JavaScript API v3 (`window.ymaps3`) that the
 * picker uses. Reference: https://yandex.ru/maps-api/docs/js-api/
 *
 * Coordinates are `[longitude, latitude]`. They only ever travel between the map and itself (the
 * pin is the map's centre): nothing here is stored, logged or sent anywhere.
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

export interface YMaps3 {
  readonly ready: Promise<void>;
  YMap: new (element: HTMLElement, props: YMapProps) => YMapInstance;
  YMapDefaultSchemeLayer: new (props?: object) => YMapEntity;
  YMapDefaultFeaturesLayer: new (props?: object) => YMapEntity;
}

declare global {
  interface Window {
    ymaps3?: YMaps3;
  }
}
