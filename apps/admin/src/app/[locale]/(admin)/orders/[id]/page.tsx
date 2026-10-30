import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { OrderDetailView } from '@/components/order-detail';
import { ORDER_ID_PATTERN } from '@/lib/orders';

/** One order. Like the list, it is mounted by `<AdminShell>` only for a signed-in operator/admin. */
export default async function OrderPage({ params }: PageProps<'/[locale]/orders/[id]'>) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !ORDER_ID_PATTERN.test(id)) notFound();

  return <OrderDetailView id={id} />;
}
