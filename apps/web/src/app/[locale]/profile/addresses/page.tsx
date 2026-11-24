import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/page-container';
import { AddressesView } from '@/components/profile/addresses-view';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';

export default async function AddressesPage({ params }: PageProps<'/[locale]/profile/addresses'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <>
      <SiteHeader
        locale={locale}
        dict={dict}
        title={dict.pageTitles.addresses}
        parentHref={`/${locale}/profile`}
      />
      <main className="flex-1">
        <PageContainer className="flex max-w-xl flex-col gap-6 py-4">
          <AddressesView />
        </PageContainer>
      </main>
    </>
  );
}
