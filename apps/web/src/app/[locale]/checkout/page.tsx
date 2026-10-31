import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { CheckoutView } from '@/components/checkout/checkout-view';
import { PageContainer } from '@/components/page-container';
import { getDictionary } from '@/i18n';

/*
 * Telegram: on this page the native MainButton is the submit control ("Buyurtma berish — <total>",
 * with progress while submitting) and the native BackButton goes to the cart (see
 * `components/telegram-chrome.tsx`). In a browser `CheckoutView` renders a sticky submit bar.
 * Both are owned by `CheckoutView`, because enabling them depends on the live quote and form.
 */
export default async function CheckoutPage({ params }: PageProps<'/[locale]/checkout'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <main className="flex-1">
      <PageContainer className="flex flex-col gap-4 py-6">
        <h1 className="text-2xl font-bold tracking-tight">{dict.checkout.title}</h1>
        <CheckoutView />
      </PageContainer>
    </main>
  );
}
