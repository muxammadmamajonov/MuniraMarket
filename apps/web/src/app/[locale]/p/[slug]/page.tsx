import { isLocale } from '@muniramarket/contracts';
import { Price } from '@muniramarket/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AddToCart } from '@/components/add-to-cart';
import { ChevronRightIcon } from '@/components/icons';
import { PageContainer } from '@/components/page-container';
import { ProductImage } from '@/components/product-image';
import { PHOTO_SIZES } from '@/lib/photo';
import { GROUP, ROWS, SECTION_TITLE } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';
import { fetchProduct } from '@/lib/api/server';
import {
  localizedDescription,
  localizedName,
  previousPrice,
  stockLabel,
  stockState,
} from '@/lib/catalog';

export async function generateMetadata({
  params,
}: PageProps<'/[locale]/p/[slug]'>): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  try {
    const product = await fetchProduct(slug);
    return product === null ? {} : { title: localizedName(product, locale) };
  } catch {
    // A failing API must not break metadata; the page itself reports the error.
    return {};
  }
}

export default async function ProductPage({ params }: PageProps<'/[locale]/p/[slug]'>) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  const product = await fetchProduct(slug);
  if (product === null) notFound();

  const name = localizedName(product, locale);
  const description = localizedDescription(product, locale);
  const state = stockState(product);
  const oldPrice = previousPrice(product);

  const stockTone =
    state.kind === 'out'
      ? 'bg-surface-muted text-muted-foreground'
      : state.kind === 'low'
        ? 'bg-warning-soft text-warning'
        : 'bg-surface text-foreground';
  const hasBrand = product.brand !== null && product.brand !== '';

  return (
    <main className="flex-1">
      <PageContainer className="grid gap-5 py-4 md:grid-cols-2 md:gap-8 md:py-6">
        <ProductImage
          src={product.image_url}
          name={name}
          toneKey={product.category_id}
          sizes={PHOTO_SIZES.detail}
          priority
          className="w-full rounded-3xl max-md:aspect-[6/5] md:max-w-md"
        />

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Link
              href={`/${locale}/c/${encodeURIComponent(product.category.slug)}`}
              aria-label={`${dict.product.category}: ${localizedName(product.category, locale)}`}
              className="inline-flex min-h-8 items-center gap-0.5 self-start rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus"
            >
              {localizedName(product.category, locale)}
              <ChevronRightIcon aria-hidden="true" width={14} height={14} />
            </Link>
            <h1
              data-user-text
              className="text-[24px] leading-[30px] font-bold tracking-[-0.02em] text-balance"
            >
              {name}
            </h1>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="flex flex-wrap items-baseline gap-x-2 text-[28px] leading-8 font-bold tracking-[-0.02em]">
              <Price
                amount={product.price_uzs}
                {...(oldPrice === null ? {} : { oldAmount: oldPrice })}
                locale={locale}
                data-testid="product-price"
                currentLabel={dict.product.priceCurrentLabel}
                oldLabel={dict.product.priceOldLabel}
              />
              <span className="text-base font-medium tracking-normal text-muted-foreground">
                / {dict.units[product.unit]}
              </span>
            </p>
            <p
              data-testid="stock-state"
              data-stock={state.kind}
              className={`inline-flex min-h-8 items-center rounded-full px-3 text-sm font-semibold ${stockTone}`}
            >
              {stockLabel(state, dict)}
            </p>
          </div>

          <AddToCart
            product={{
              id: product.id,
              price_uzs: product.price_uzs,
              in_stock: product.in_stock,
              stock_quantity: product.stock_quantity,
            }}
          />

          <section aria-labelledby="details-heading" className={`${GROUP} flex flex-col gap-3 p-4`}>
            <h2 id="details-heading" className={SECTION_TITLE}>
              {dict.product.about}
            </h2>
            {description !== null ? (
              <p data-user-text className="whitespace-pre-line text-foreground/80">
                {description}
              </p>
            ) : null}
            <dl className={`${ROWS} flex flex-col text-sm`}>
              <div className="flex justify-between gap-3 py-2.5 first:pt-0">
                <dt className="text-muted-foreground">{dict.product.sku}</dt>
                <dd data-testid="product-sku" className="font-medium tabular-nums">
                  {product.sku}
                </dd>
              </div>
              {hasBrand ? (
                <div className="flex justify-between gap-3 py-2.5 last:pb-0">
                  <dt className="text-muted-foreground">{dict.product.brand}</dt>
                  <dd data-user-text className="min-w-0 text-right font-medium">
                    {product.brand}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        </div>
      </PageContainer>
    </main>
  );
}
