import { vi, type Mock } from 'vitest';
import type {
  LngLat,
  YMapListenerProps,
  YMapProps,
  YMaps3,
  YSearchFeature,
  YSearchOptions,
} from './yandex-types';

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
  /** `ymaps3.search`; answers `[]` unless a test sets an implementation. */
  search: Mock<(options: YSearchOptions) => Promise<YSearchFeature[]>>;
  /** Keys passed to `getDefaultConfig().setApikeys`. */
  setApikeys: Mock<(keys: { search?: string }) => void>;
  /** Every `YMapListener` added to a map; call `onActionStart` to simulate a drag. */
  listeners: YMapListenerProps[];
}

/** A toponym result as `ymaps3.search` returns it. */
export function toponym(name: string, description: string): YSearchFeature {
  return { properties: { name, description } };
}

export interface MakeYMapsOptions {
  /** Leave out `search` (an SDK build without geosearch). */
  withoutSearch?: boolean;
}

export function makeYMaps({ withoutSearch = false }: MakeYMapsOptions = {}): FakeYMaps {
  const maps: FakeMap[] = [];
  const listeners: YMapListenerProps[] = [];
  const search = vi.fn<(options: YSearchOptions) => Promise<YSearchFeature[]>>(() =>
    Promise.resolve([]),
  );
  const setApikeys = vi.fn<(keys: { search?: string }) => void>();

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
    getDefaultConfig: () => ({ setApikeys }),
    ...(withoutSearch ? {} : { search }),
  } as unknown as YMaps3;

  return { api, maps, search, setApikeys, listeners };
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
