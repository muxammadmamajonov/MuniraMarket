import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { LanguageSetting } from '@/components/language-setting';
import { PageContainer } from '@/components/page-container';
import { SiteHeader } from '@/components/site-header';
import { getDictionary } from '@/i18n';

export default async function LanguagePage({ params }: PageProps<'/[locale]/profile/language'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <>
      <SiteHeader
        locale={locale}
        dict={dict}
        title={dict.pageTitles.language}
        parentHref={`/${locale}/profile`}
      />
      <main className="flex-1">
        <PageContainer className="flex max-w-xl flex-col gap-6 py-4">
          <LanguageSetting />
        </PageContainer>
      </main>
    </>
  );
}
