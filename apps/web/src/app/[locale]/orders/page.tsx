import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { OrdersList } from '@/components/orders/orders-list';
import { PageContainer } from '@/components/page-container';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';
import { parsePage } from '@/lib/catalog';

export default async function OrdersPage({ params, searchParams }: PageProps<'/[locale]/orders'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const page = parsePage((await searchParams)['page']);

  return (
    <>
      <SiteHeader locale={locale} dict={dict} title={dict.pageTitles.orders} />
      <main className="flex-1">
        <PageContainer className="flex flex-col gap-4 py-4">
          <OrdersList page={page} />
        </PageContainer>
      </main>
    </>
  );
}
