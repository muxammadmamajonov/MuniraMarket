import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ProductFormView } from '@/components/catalog/product-form';
import { ORDER_ID_PATTERN } from '@/lib/orders';

/** One product (ids are UUIDs; anything else cannot exist, so no request is made for it). */
export default async function ProductPage({
  params,
}: PageProps<'/[locale]/catalog/products/[id]'>) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !ORDER_ID_PATTERN.test(id)) notFound();

  return (
    <Suspense fallback={null}>
      <ProductFormView id={id} />
    </Suspense>
  );
}
