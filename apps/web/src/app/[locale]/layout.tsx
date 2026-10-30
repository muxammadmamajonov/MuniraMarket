import { SUPPORTED_LOCALES, isLocale } from '@muniramarket/contracts';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import Script from 'next/script';
import { OfflineBanner } from '@/components/offline-banner';
import { SiteHeader } from '@/components/site-header';
import { TelegramChrome } from '@/components/telegram-chrome';
import { getDictionary } from '@/i18n';
import { LocaleProvider } from '@/i18n/context';
import { SessionProvider } from '@/lib/session';
import { TELEGRAM_WEB_APP_SCRIPT_URL, TelegramProvider } from '@/lib/telegram';
import '../globals.css';

// Only the supported locales exist; anything else is a 404 without rendering.
export const dynamicParams = false;

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets `env(safe-area-inset-*)` work (notch / home indicator), including in the Mini App.
  viewportFit: 'cover',
  // Keep bottom controls visible when the phone keyboard opens.
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { meta } = getDictionary(locale);
  return { title: meta.title, description: meta.description };
}

export default async function RootLayout({ children, params }: LayoutProps<'/[locale]'>) {
  // The Content-Security-Policy nonce (src/proxy.ts) exists only on a live request, and Next can
  // apply it only while rendering that request. Opting the whole tree into dynamic rendering
  // means no page is prerendered at build time without a nonce.
  await connection();

  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);

  return (
    <html lang={locale}>
      <head>
        {/*
          Official Telegram Web Apps script. It must run before hydration so that
          `window.Telegram.WebApp` exists on first client render. It is mutable and cannot be
          pinned with SRI; it is loaded from Telegram's own origin by design.
        */}
        <Script src={TELEGRAM_WEB_APP_SCRIPT_URL} strategy="beforeInteractive" />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <TelegramProvider>
            <SessionProvider>
              <TelegramChrome />
              <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
                <OfflineBanner />
                <SiteHeader locale={locale} dict={dict} />
                {children}
              </div>
            </SessionProvider>
          </TelegramProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
