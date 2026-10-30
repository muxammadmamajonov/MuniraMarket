import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CartView } from '@/components/cart-view';
import { PageContainer } from '@/components/page-container';
import { getDictionary } from '@/i18n';

/*
 * Telegram MainButton: deliberately hidden on this page. Checkout does not exist yet, and a
 * permanently disabled native button at the bottom of the Mini App would look broken; the in-page
 * "checkout coming soon" note says it instead. When checkout lands, claim the button here with
 * `useMainButton({ text: "Checkout — <total>", ... })`.
 */
export default async function CartPage({ params }: PageProps<'/[locale]/cart'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-4 py-6">
        <h1 className="text-2xl font-bold tracking-tight">{dict.cart.title}</h1>
        <CartView />
      </PageContainer>
    </main>
  );
}
