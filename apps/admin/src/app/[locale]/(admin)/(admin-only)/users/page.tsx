import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { UsersView } from '@/components/users/users-view';

export default async function Page({ params }: PageProps<'/[locale]/users'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  // List filters and the page live in the URL (`useSearchParams`), which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <UsersView />
    </Suspense>
  );
}
