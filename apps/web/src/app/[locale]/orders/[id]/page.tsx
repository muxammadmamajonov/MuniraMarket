import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { OrderDetailView } from '@/components/orders/order-detail-view';
import { PageContainer } from '@/components/page-container';
import { firstParam } from '@/lib/catalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrderPage({
  params,
  searchParams,
}: PageProps<'/[locale]/orders/[id]'>) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) notFound();
  // `?placed=1` after a new order, `?placed=found` when a retry was answered with an order an
  // earlier attempt had already created.
  const placedParam = firstParam((await searchParams)['placed']);
  const placed = placedParam === '1' || placedParam === 'found';

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-4 py-6">
        <OrderDetailView id={id} placed={placed} found={placedParam === 'found'} />
      </PageContainer>
    </main>
  );
}
