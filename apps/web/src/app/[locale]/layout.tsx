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
import { CartProvider } from '@/lib/cart';
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
    { media: '(prefers-color-scheme: light)', color: '#faf8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#121214' },
  ],
};

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const { meta } = getDictionary(locale);
  return {
    title: meta.title,
    description: meta.description,
    // Generated from the shared mark by `scripts/export-brand.mts`.
    icons: {
      icon: [{ url: '/brand/munira-mark.svg', type: 'image/svg+xml' }],
      apple: [{ url: '/brand/munira-app-icon-180.png', sizes: '180x180' }],
    },
  };
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
              <CartProvider>
                <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
                  {/* Below the header: the header pads itself by the top safe-area inset, so a banner
                      above it would sit under the notch / status bar in fullscreen and installed modes. */}
                  <SiteHeader locale={locale} dict={dict} />
                  <OfflineBanner />
                  {children}
                </div>
              </CartProvider>
            </SessionProvider>
          </TelegramProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
