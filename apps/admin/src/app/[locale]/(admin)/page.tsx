import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { OrdersList } from '@/components/orders-list';

/*
 * Orders list. Access control, in short (details: `src/proxy.ts`):
 *   - Core API is the security boundary: it re-reads the user's role from the database on every
 *     `/api/v1/admin/**` request and refuses anyone who is not an operator/admin (401/403), and it
 *     enforces CSRF on writes.
 *   - This page is rendered inside `<AdminShell>` (`./layout.tsx`), which mounts `<OrdersList>`,
 *     the only thing here that requests order data, solely for a signed-in operator/admin. The
 *     server-rendered HTML contains no order data at all.
 */
export default async function OrdersPage({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    // `useSearchParams` (the status filter and page live in the URL) needs a Suspense boundary.
    <Suspense fallback={null}>
      <OrdersList />
    </Suspense>
  );
}
