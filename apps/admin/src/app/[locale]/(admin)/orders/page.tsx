import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { OrdersList } from '@/components/orders-list';

/** Orders list (operators and admins), mounted by `<AdminShell>` only for a signed-in operator/admin. */
export default async function OrdersPage({ params }: PageProps<'/[locale]/orders'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    // `useSearchParams` (the status filter and page live in the URL) needs a Suspense boundary.
    <Suspense fallback={null}>
      <OrdersList />
    </Suspense>
  );
}
