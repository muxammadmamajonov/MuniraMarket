import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { OrdersList } from '@/components/orders/orders-list';
import { PageContainer } from '@/components/page-container';
import { getDictionary } from '@/i18n';
import { parsePage } from '@/lib/catalog';

export default async function OrdersPage({ params, searchParams }: PageProps<'/[locale]/orders'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const page = parsePage((await searchParams)['page']);

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-4 py-6">
        <h1 className="text-2xl font-bold tracking-tight">{dict.orders.title}</h1>
        <OrdersList page={page} />
      </PageContainer>
    </main>
  );
}
