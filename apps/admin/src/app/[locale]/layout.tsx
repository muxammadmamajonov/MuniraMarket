import { SUPPORTED_LOCALES, isLocale } from '@muniramarket/contracts';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { getDictionary } from '@/i18n';
import { LocaleProvider } from '@/i18n/context';
import { SessionProvider } from '@/lib/session';
import '../globals.css';

// Only the supported locales exist; anything else is a 404 without rendering.
export const dynamicParams = false;

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Paint under the notch / home indicator; the shell pads its content back with `env(safe-area-*)`.
  viewportFit: 'cover',
  // The on-screen keyboard shrinks the layout viewport (Android Chrome), as it already does on iOS.
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  // The status bar takes the colour of the top bar (`bg-surface`), per colour scheme.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#18181b' },
  ],
};

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { meta } = getDictionary(locale);
  return {
    title: meta.title,
    description: meta.description,
    // The admin must never be indexed. `X-Robots-Tag` (next.config.ts) and robots.txt back this up.
    robots: { index: false, follow: false, nocache: true },
  };
}

export default async function RootLayout({ children, params }: LayoutProps<'/[locale]'>) {
  // The Content-Security-Policy nonce (src/proxy.ts) exists only on a live request, and Next can
  // apply it only while rendering that request. Opting the whole tree into dynamic rendering
  // means no page is prerendered at build time without a nonce.
  await connection();

  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale}>
      <body>
        <LocaleProvider locale={locale}>
          <SessionProvider>{children}</SessionProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
