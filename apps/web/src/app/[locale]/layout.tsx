import { SUPPORTED_LOCALES, isLocale } from '@muniramarket/contracts';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import Script from 'next/script';
import { getDictionary } from '@/i18n';
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
};

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { meta } = getDictionary(locale);
  return { title: meta.title, description: meta.description };
}

export default async function RootLayout({ children, params }: LayoutProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

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
        <TelegramProvider>{children}</TelegramProvider>
      </body>
    </html>
  );
}
