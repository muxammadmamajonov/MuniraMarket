import { vi, type Mock } from 'vitest';
import type { AddressComponent, GeocoderResult } from './reverse-geocode';
import type { LngLat, YMapListenerProps, YMapProps, YMaps3 } from './yandex-types';

/**
 * A fake `window.ymaps3` for tests. Test-only; not imported by app code. Nothing here (or in any
 * test) loads anything from Yandex: jsdom does not fetch external scripts, and
 * `autoloadYandexScript` fires the script's `load`/`error` itself.
 */

export interface FakeMap {
  element: HTMLElement;
  props: YMapProps;
  center: LngLat;
  zoom: number;
  children: object[];
  update: Mock<(props: { location?: { center: LngLat; zoom: number } }) => void>;
  destroy: Mock<() => void>;
}

export interface FakeYMaps {
  api: YMaps3;
  maps: FakeMap[];
  /** Every `YMapListener` added to a map; call `onActionStart` to simulate a drag. */
  listeners: YMapListenerProps[];
}

export function makeYMaps(): FakeYMaps {
  const maps: FakeMap[] = [];
  const listeners: YMapListenerProps[] = [];

  class YMapListener {
    constructor(props: YMapListenerProps) {
      listeners.push(props);
    }
  }

  class YMap {
    readonly fake: FakeMap;

    constructor(element: HTMLElement, props: YMapProps) {
      const fake: FakeMap = {
        element,
        props,
        center: props.location.center,
        zoom: props.location.zoom,
        children: [],
        update: vi.fn((next: { location?: { center: LngLat; zoom: number } }) => {
          if (next.location !== undefined) {
            fake.center = next.location.center;
            fake.zoom = next.location.zoom;
          }
        }),
        destroy: vi.fn(),
      };
      this.fake = fake;
      maps.push(fake);
    }

    get center(): LngLat {
      return this.fake.center;
    }

    get zoom(): number {
      return this.fake.zoom;
    }

    addChild(child: object) {
      this.fake.children.push(child);
      return this;
    }

    update(props: { location?: { center: LngLat; zoom: number } }) {
      this.fake.update(props);
    }

    destroy() {
      this.fake.destroy();
    }
  }

  const api = {
    ready: Promise.resolve(),
    YMap,
    YMapDefaultSchemeLayer: class {},
    YMapDefaultFeaturesLayer: class {},
    YMapListener,
  } as unknown as YMaps3;

  return { api, maps, listeners };
}

/** Address components of a Tashkent house, most general first, as the Geocoder lists them. */
export function houseComponents(street: string, house: string): AddressComponent[] {
  return [
    { kind: 'country', name: 'Узбекистан' },
    { kind: 'province', name: 'Ташкент' },
    { kind: 'locality', name: 'Ташкент' },
    { kind: 'street', name: street },
    { kind: 'house', name: house },
  ];
}

/** A Geocoder result for a house on a street: name "<street>, <house>". */
export function houseResult(street: string, house: string): GeocoderResult {
  return { name: `${street}, ${house}`, components: houseComponents(street, house) };
}

/**
 * The Geocoder HTTP API's JSON for `result` (`null`: nothing found). Only the parts the parser
 * reads, in their real places (`GeoObject.name`, `metaDataProperty.GeocoderMetaData.Address`).
 */
export function geocoderBody(result: GeocoderResult | null): unknown {
  return {
    response: {
      GeoObjectCollection: {
        featureMember:
          result === null
            ? []
            : [
                {
                  GeoObject: {
                    name: result.name,
                    description: 'Ташкент, Узбекистан',
                    metaDataProperty: {
                      GeocoderMetaData: {
                        kind: 'house',
                        text: `Узбекистан, Ташкент, ${result.name}`,
                        Address: {
                          country_code: 'UZ',
                          formatted: `Узбекистан, Ташкент, ${result.name}`,
                          Components: result.components,
                        },
                      },
                    },
                  },
                },
              ],
      },
    },
  };
}

/** What the fake Geocoder answers for a `geocode` parameter (`"lng,lat"`). */
export type GeocoderAnswer = (geocode: string) => Promise<GeocoderResult | null | Response>;

/**
 * Makes the Geocoder HTTP boundary deterministic: every `fetch` is answered by `answer` (nothing
 * found by default; return a `Response` for an HTTP failure, or reject for a network failure).
 * Nothing reaches Yandex. `answer.mock.calls` are the `geocode` parameters looked up.
 */
export function mockGeocoderFetch(): {
  answer: Mock<GeocoderAnswer>;
  fetch: ReturnType<typeof vi.spyOn>;
} {
  const answer = vi.fn<GeocoderAnswer>(() => Promise.resolve(null));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const result = await answer(url.searchParams.get('geocode') ?? '');
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(geocoderBody(result)), { status: 200 });
  });
  return { answer, fetch };
}

/**
 * Intercepts the loader's `<script>` and settles it: `load` (with `api` installed as
 * `window.ymaps3`), `error`, or `hang` (never settles, for timeouts). Returns the spy.
 */
export function autoloadYandexScript(
  behaviour: 'load' | 'error' | 'hang',
  api?: YMaps3,
): ReturnType<typeof vi.spyOn> {
  const original = document.head.append.bind(document.head);
  return vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    original(...nodes);
    for (const node of nodes) {
      if (!(node instanceof HTMLScriptElement) || !('mmYandexMaps' in node.dataset)) continue;
      queueMicrotask(() => {
        if (behaviour === 'load') {
          if (api === undefined) delete window.ymaps3;
          else window.ymaps3 = api;
          node.dispatchEvent(new Event('load'));
        } else if (behaviour === 'error') {
          node.dispatchEvent(new Event('error'));
        }
      });
    }
  });
}
