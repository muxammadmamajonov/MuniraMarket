import { describe, expect, it } from 'vitest';
import { getDictionary } from '@/i18n';
import { NO_INDEX, pageTitle, titledMetadata } from './page-metadata';

const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

describe('titledMetadata', () => {
  it('titles a private page in the visitor language and keeps it out of search engines', async () => {
    const uz = await titledMetadata('cart')(params('uz'));
    expect(uz.title).toBe(`${getDictionary('uz').pageTitles.cart} · MuniraMarket`);
    expect(uz.robots).toEqual(NO_INDEX);
    const ru = await titledMetadata('orders')(params('ru'));
    expect(ru.title).toBe(`${getDictionary('ru').pageTitles.orders} · MuniraMarket`);
    expect(ru.robots).toEqual({ index: false, follow: false });
  });

  it('leaves an indexable page indexable', async () => {
    const meta = await titledMetadata('catalog', { indexable: true })(params('ru'));
    expect(meta.title).toBe(pageTitle(getDictionary('ru'), getDictionary('ru').pageTitles.catalog));
    expect(meta.robots).toBeUndefined();
  });

  it('gives an indexable page with a path its canonical URL and hreflang alternates', async () => {
    const meta = await titledMetadata('catalog', { indexable: true, path: '/catalog' })(
      params('ru'),
    );
    expect(meta.alternates).toEqual({
      canonical: '/ru/catalog',
      languages: { uz: '/uz/catalog', ru: '/ru/catalog', 'x-default': '/uz/catalog' },
    });
    expect(meta.robots).toBeUndefined();
  });

  it('never adds alternates to a private page', async () => {
    expect(
      (await titledMetadata('cart', { path: '/cart' })(params('uz'))).alternates,
    ).toBeUndefined();
  });

  it('returns nothing for an unknown locale', async () => {
    expect(await titledMetadata('cart')(params('xx'))).toEqual({});
  });
});
