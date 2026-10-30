import { isLocale } from '@muniramarket/contracts';
import { ImagePlaceholder, Price } from '@muniramarket/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AddToCart } from '@/components/add-to-cart';
import { PageContainer } from '@/components/page-container';
import { getDictionary } from '@/i18n';
import { fetchProduct } from '@/lib/api/server';
import { localizedDescription, localizedName, stockLabel, stockState } from '@/lib/catalog';

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

  return (
    <main className="flex-1">
      <PageContainer className="grid gap-6 py-6 md:grid-cols-2">
        <ImagePlaceholder src={product.image_url} alt={name} className="max-w-md" />

        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {dict.product.category}:{' '}
            <Link
              href={`/${locale}/c/${encodeURIComponent(product.category.slug)}`}
              className="underline underline-offset-2"
            >
              {localizedName(product.category, locale)}
            </Link>
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{name}</h1>

          <p className="flex flex-wrap items-baseline gap-x-2 text-2xl">
            <Price
              amount={product.price_uzs}
              {...(product.old_price_uzs === null ? {} : { oldAmount: product.old_price_uzs })}
              locale={locale}
              data-testid="product-price"
              currentLabel={dict.product.priceCurrentLabel}
              oldLabel={dict.product.priceOldLabel}
            />
            <span className="text-base text-muted-foreground">/ {dict.units[product.unit]}</span>
          </p>

          <p
            data-testid="stock-state"
            data-stock={state.kind}
            className={state.kind === 'in' ? 'text-sm' : 'text-sm font-medium'}
          >
            {stockLabel(state, dict)}
          </p>

          <AddToCart
            product={{
              id: product.id,
              price_uzs: product.price_uzs,
              in_stock: product.in_stock,
              stock_quantity: product.stock_quantity,
            }}
          />

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{dict.product.sku}</dt>
            <dd data-testid="product-sku">{product.sku}</dd>
            {product.brand !== null && product.brand !== '' ? (
              <>
                <dt className="text-muted-foreground">{dict.product.brand}</dt>
                <dd>{product.brand}</dd>
              </>
            ) : null}
          </dl>

          {description !== null ? (
            <section aria-labelledby="description-heading" className="flex flex-col gap-1">
              <h2 id="description-heading" className="font-semibold">
                {dict.product.description}
              </h2>
              <p className="whitespace-pre-line text-muted-foreground">{description}</p>
            </section>
          ) : null}
        </div>
      </PageContainer>
    </main>
  );
}
