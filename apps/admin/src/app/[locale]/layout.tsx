import { SUPPORTED_LOCALES, isLocale } from '@muniramarket/contracts';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { getDictionary } from '@/i18n';
import '../globals.css';

// Only the supported locales exist; anything else is a 404 without rendering.
export const dynamicParams = false;

export function generateStaticParams() {
  return SUPPORTED_LOCALES.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
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
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
