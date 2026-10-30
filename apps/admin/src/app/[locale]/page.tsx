import { isLocale } from '@muniramarket/contracts';
import { Container, Screen } from '@muniramarket/ui';
import { notFound } from 'next/navigation';
import { getDictionary } from '@/i18n';

/*
 * TODO(admin-auth): REQUIRED BEFORE ANY DATA ACCESS. Do not add an admin route, API call or data
 * view until authentication is in place. Requirements:
 *   - role-based: only `operator` / `admin` users (see `UserRole` in @muniramarket/contracts);
 *   - verified on the server for every request (server components, route handlers, proxy checks
 *     are a convenience only), never trusted from client-side state, a cookie flag or a header
 *     the browser can set;
 *   - the Core API must enforce the same roles independently; the admin UI is not a security
 *     boundary.
 * Until then this page is a static placeholder and exposes no data.
 */
export default async function DashboardPage({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const { dashboard } = getDictionary(locale);

  return (
    <Screen>
      <Container className="flex flex-1 flex-col gap-3 py-8">
        <h1 className="text-3xl font-bold tracking-tight">{dashboard.title}</h1>
        <p className="text-lg text-muted-foreground">{dashboard.placeholder}</p>
      </Container>
    </Screen>
  );
}
