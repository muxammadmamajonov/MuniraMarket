import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/page-container';
import { SiteHeader } from '@/components/site-header';
import { ProfileView } from '@/components/profile-view';
import { getDictionary } from '@/i18n';

export default async function ProfilePage({ params }: PageProps<'/[locale]/profile'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <>
      <SiteHeader locale={locale} dict={dict} title={dict.pageTitles.profile} />
      <main className="flex-1">
        <PageContainer className="flex max-w-xl flex-col gap-6 py-4">
          <ProfileView />
        </PageContainer>
      </main>
    </>
  );
}
