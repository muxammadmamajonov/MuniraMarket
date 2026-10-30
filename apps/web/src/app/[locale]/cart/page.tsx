import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CartView } from '@/components/cart-view';
import { PageContainer } from '@/components/page-container';
import { getDictionary } from '@/i18n';

/*
 * Telegram MainButton: `CartView` claims it ("Rasmiylashtirish — <total>", which opens the
 * checkout) once the cart is loaded, has lines and no line has an issue. It stays hidden for an
 * empty or problematic cart, and is released again when this page unmounts.
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
