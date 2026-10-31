import { isLocale } from '@muniramarket/contracts';
import { notFound } from 'next/navigation';
import { DashboardView } from '@/components/dashboard';

/*
 * Landing page: today's numbers (operators and admins). Access control, in short (details:
 * `src/proxy.ts`): Core API is the security boundary (it re-reads the role on every
 * `/api/v1/admin/**` request); this page is mounted by `<AdminShell>` (`./layout.tsx`) only for a
 * signed-in operator/admin, and the server-rendered HTML contains no back-office data.
 */
export default async function DashboardPage({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return <DashboardView />;
}
