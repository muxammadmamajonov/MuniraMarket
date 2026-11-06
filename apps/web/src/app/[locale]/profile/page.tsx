import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/page-container';
import { ProfileView } from '@/components/profile-view';
import { getDictionary } from '@/i18n';

export default async function ProfilePage({ params }: PageProps<'/[locale]/profile'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <main className="flex-1">
      <PageContainer className="flex max-w-xl flex-col gap-4 py-4">
        <h1 className="text-2xl font-bold tracking-tight">{dict.profile.title}</h1>
        <ProfileView />
      </PageContainer>
    </main>
  );
}
