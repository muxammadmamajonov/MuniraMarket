import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/page-container';
import { PersonalInfoView } from '@/components/profile/personal-info-view';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';

export default async function PersonalInfoPage({
  params,
}: PageProps<'/[locale]/profile/personal'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <>
      <SiteHeader
        locale={locale}
        dict={dict}
        title={dict.pageTitles.personal}
        parentHref={`/${locale}/profile`}
      />
      <main className="flex-1">
        <PageContainer className="flex max-w-xl flex-col gap-6 py-4">
          <PersonalInfoView />
        </PageContainer>
      </main>
    </>
  );
}
