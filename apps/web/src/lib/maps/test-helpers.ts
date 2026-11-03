import { vi, type Mock } from 'vitest';
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
  listeners: YMapListenerProps[];
}

export function makeYMaps(): FakeYMaps {
  const maps: FakeMap[] = [];
  const listeners: YMapListenerProps[] = [];

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

  class YMapListener {
    constructor(props: YMapListenerProps) {
      listeners.push(props);
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
