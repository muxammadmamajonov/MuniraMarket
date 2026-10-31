import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ImportExportView } from '@/components/catalog/import-export';

export default async function Page({ params }: PageProps<'/[locale]/catalog/import'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // List filters and the page live in the URL (`useSearchParams`), which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ImportExportView />
    </Suspense>
  );
}
