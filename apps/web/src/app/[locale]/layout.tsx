import { SUPPORTED_LOCALES, isLocale } from '@muniramarket/contracts';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import Script from 'next/script';
import { BottomNav } from '@/components/bottom-nav';
import { LocaleSync } from '@/components/locale-sync';
import { OfflineBanner } from '@/components/offline-banner';
import { SiteHeader } from '@/components/site-header';
import { TelegramChrome } from '@/components/telegram-chrome';
import { getDictionary } from '@/i18n';
import { LocaleProvider } from '@/i18n/context';
import { CartProvider } from '@/lib/cart';
import { nonceFromContentSecurityPolicy } from '@/lib/csp';
import { readYandexMapsGeocoderApiKey, readYandexMapsJavaScriptApiKey } from '@/lib/maps/config';
import { MapsConfigProvider } from '@/lib/maps/use-yandex-maps';
import { SessionProvider } from '@/lib/session';
import { TELEGRAM_WEB_APP_SCRIPT_URL, TelegramProvider } from '@/lib/telegram';
import { BotUsernameProvider } from '@/lib/telegram/bot-link';
import { readTelegramBotUsername } from '@/lib/telegram/bot-username';
import '../globals.css';

// Only the supported locales exist; anything else is a 404 without rendering.
export const dynamicParams = false;

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets `env(safe-area-inset-*)` work (notch / home indicator), including in the Mini App; the
  // shell pads by the `--mm-inset-*` variables built from it (globals.css).
  viewportFit: 'cover',
  // Keep bottom controls visible when the phone keyboard opens.
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f3ef' },
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
  // Read per request like the other runtime settings; `null` (unset or malformed) keeps the map
  // picker in its custom "map unavailable" state and nothing is ever loaded from Yandex.
  const mapsApiKey = readYandexMapsJavaScriptApiKey();
  const geocoderApiKey = readYandexMapsGeocoderApiKey();
  // The per-request nonce from src/proxy.ts, passed to `<Script>` explicitly so the client renders
  // the same `nonce` as the server HTML (see `nonceFromContentSecurityPolicy`).
  const nonce = nonceFromContentSecurityPolicy((await headers()).get('content-security-policy'));

  return (
    // `suppressHydrationWarning` covers only this element's own attributes: the Telegram script
    // below runs before hydration and sets `--tg-viewport-*` inline styles on <html>, which the
    // client render does not have. Nothing below <html> is affected.
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/*
          Official Telegram Web Apps script. It must run before hydration so that
          `window.Telegram.WebApp` exists on first client render. It is mutable and cannot be
          pinned with SRI; it is loaded from Telegram's own origin by design.
        */}
        <Script src={TELEGRAM_WEB_APP_SCRIPT_URL} strategy="beforeInteractive" nonce={nonce} />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <BotUsernameProvider username={readTelegramBotUsername()}>
            <TelegramProvider>
              <SessionProvider>
                <TelegramChrome />
                <LocaleSync />
                <CartProvider>
                  <MapsConfigProvider apiKey={mapsApiKey} geocoderApiKey={geocoderApiKey}>
                    {/* Bottom padding: the home indicator / Telegram's bottom inset, plus the mobile
                      tab bar while it is shown (`--mm-nav-h`, see globals.css). */}
                    <div className="flex min-h-dvh flex-col pb-[calc(var(--mm-inset-bottom)+var(--mm-nav-h))]">
                      {/* Below the header: the header pads itself by the top safe-area inset, so a
                        banner above it would sit under the notch / status bar in fullscreen and
                        installed modes. */}
                      <SiteHeader locale={locale} dict={dict} />
                      <OfflineBanner />
                      {children}
                    </div>
                    <BottomNav />
                  </MapsConfigProvider>
                </CartProvider>
              </SessionProvider>
            </TelegramProvider>
          </BotUsernameProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
