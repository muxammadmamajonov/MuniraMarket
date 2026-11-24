import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { OrderStatusTabs } from '@/components/orders/order-status-tabs';
import { parseStatusGroup } from '@/lib/orders/status-group';
import { OrdersList } from '@/components/orders/orders-list';
import { PageContainer } from '@/components/page-container';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';
import { parsePage } from '@/lib/catalog';

export default async function OrdersPage({ params, searchParams }: PageProps<'/[locale]/orders'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const query = await searchParams;
  const page = parsePage(query['page']);
  const statusGroup = parseStatusGroup(query['status']);

  return (
    <>
      <SiteHeader
        locale={locale}
        dict={dict}
        title={dict.pageTitles.orders}
        parentHref={`/${locale}/profile`}
      />
      <main className="flex-1">
        <PageContainer className="flex flex-col gap-4 py-4">
          <OrderStatusTabs active={statusGroup} />
          <OrdersList
            key={`${statusGroup}-${String(page)}`}
            page={page}
            statusGroup={statusGroup}
          />
        </PageContainer>
      </main>
    </>
  );
}
