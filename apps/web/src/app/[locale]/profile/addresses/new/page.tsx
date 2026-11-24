import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/page-container';
import { AddressEditorView } from '@/components/profile/address-editor-view';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';

export default async function NewAddressPage({
  params,
}: PageProps<'/[locale]/profile/addresses/new'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <>
      <SiteHeader
        locale={locale}
        dict={dict}
        title={dict.pageTitles.newAddress}
        parentHref={`/${locale}/profile/addresses`}
      />
      <main className="flex-1">
        <PageContainer className="flex max-w-xl flex-col gap-6 py-4">
          <AddressEditorView addressId={null} />
        </PageContainer>
      </main>
    </>
  );
}
