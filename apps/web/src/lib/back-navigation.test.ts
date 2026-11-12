import { describe, expect, it } from 'vitest';
import { getDictionary } from '@/i18n';
import {
  canGoBack,
  isCheckoutPath,
  isRootPath,
  logicalParent,
  parentFor,
  registerParent,
  staticTitleFor,
} from './back-navigation';

describe('isRootPath', () => {
  it('is true for the four bottom-nav tabs only', () => {
    for (const path of ['/uz', '/ru/', '/uz/catalog', '/ru/cart', '/uz/profile']) {
      expect(isRootPath(path), path).toBe(true);
    }
    for (const path of [
      '/uz/c/fruits',
      '/uz/p/olma',
      '/uz/search',
      '/uz/checkout',
      '/uz/orders',
      '/uz/orders/1',
      '/uz/help',
      '/uz/catalog/x',
      '/catalog',
      '/',
    ]) {
      expect(isRootPath(path), path).toBe(false);
    }
  });
});

describe('isCheckoutPath', () => {
  it('is true only for the checkout page', () => {
    expect(isCheckoutPath('/uz/checkout')).toBe(true);
    expect(isCheckoutPath('/ru/checkout')).toBe(true);
    expect(isCheckoutPath('/uz/cart')).toBe(false);
    expect(isCheckoutPath('/uz/checkout/x')).toBe(false);
    expect(isCheckoutPath('/checkout')).toBe(false);
  });
});

describe('logicalParent', () => {
  it('climbs one level, keeping the locale', () => {
    expect(logicalParent('/uz/c/fruits')).toBe('/uz/catalog');
    expect(logicalParent('/ru/p/olma')).toBe('/ru/catalog');
    expect(logicalParent('/uz/search')).toBe('/uz/catalog');
    expect(logicalParent('/uz/checkout')).toBe('/uz/cart');
    expect(logicalParent('/uz/orders/abc')).toBe('/uz/orders');
    expect(logicalParent('/uz/orders')).toBe('/uz/profile');
    expect(logicalParent('/ru/help')).toBe('/ru/profile');
    expect(logicalParent('/uz/auth/telegram')).toBe('/uz');
    expect(logicalParent('/elsewhere')).toBe('/');
  });
});

describe('parentFor / registerParent', () => {
  it("prefers a page's own parent for its path only, and forgets it on cleanup", () => {
    const unregister = registerParent('/uz/p/olma/', '/uz/c/fruits');
    expect(parentFor('/uz/p/olma')).toBe('/uz/c/fruits');
    expect(parentFor('/uz/p/nok')).toBe('/uz/catalog');
    unregister();
    expect(parentFor('/uz/p/olma')).toBe('/uz/catalog');
  });

  it("does not let an old page's cleanup erase the next page's registration", () => {
    const first = registerParent('/uz/p/olma', '/uz/c/fruits');
    const second = registerParent('/uz/c/apples', '/uz/c/fruits');
    first();
    expect(parentFor('/uz/c/apples')).toBe('/uz/c/fruits');
    second();
  });
});

describe('canGoBack', () => {
  const history = (length: number) => ({ length }) as History;

  it('uses the Navigation API index when there is one', () => {
    const win = (index: number, length: number) =>
      ({ history: history(length), navigation: { currentEntry: { index } } }) as unknown as Window;
    expect(canGoBack(win(0, 5))).toBe(false);
    expect(canGoBack(win(2, 1))).toBe(true);
  });

  it('falls back to history.length', () => {
    expect(canGoBack({ history: history(1) })).toBe(false);
    expect(canGoBack({ history: history(2) })).toBe(true);
  });
});

describe('staticTitleFor', () => {
  const uz = getDictionary('uz');
  const ru = getDictionary('ru');

  it('gives the logo at home, a title on known pages and an empty slot for data pages', () => {
    expect(staticTitleFor('/uz', uz)).toBeUndefined();
    expect(staticTitleFor('/uz/catalog', uz)).toBe('Katalog');
    expect(staticTitleFor('/uz/cart', uz)).toBe('Savat');
    expect(staticTitleFor('/uz/checkout', uz)).toBe('Buyurtma');
    expect(staticTitleFor('/uz/orders', uz)).toBe('Buyurtmalar');
    expect(staticTitleFor('/uz/orders/1', uz)).toBe('Buyurtma');
    expect(staticTitleFor('/uz/profile', uz)).toBe('Profil');
    expect(staticTitleFor('/uz/search', uz)).toBe('Qidiruv');
    expect(staticTitleFor('/ru/catalog', ru)).toBe('Каталог');
    expect(staticTitleFor('/ru/help', ru)).toBe('Помощь');
    expect(staticTitleFor('/uz/c/fruits', uz)).toBeNull();
    expect(staticTitleFor('/uz/p/olma', uz)).toBeNull();
  });

  it('keeps every fixed title short enough for the header slot on a 320px phone', () => {
    for (const dict of [uz, ru]) {
      for (const title of Object.values(dict.pageTitles)) {
        expect(title.length, title).toBeLessThanOrEqual(12);
      }
    }
  });
});
