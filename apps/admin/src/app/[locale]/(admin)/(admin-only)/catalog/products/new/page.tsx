import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ProductFormView } from '@/components/catalog/product-form';

export default async function NewProductPage({
  params,
}: PageProps<'/[locale]/catalog/products/new'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <Suspense fallback={null}>
      <ProductFormView />
    </Suspense>
  );
}
