import { isLocale } from '@muniramarket/contracts';
import { Container, Price, Screen } from '@muniramarket/ui';
import { notFound } from 'next/navigation';
import { LanguageSwitcher } from '@/components/language-switcher';
import { TelegramStatus } from '@/components/telegram-status';
import { getDictionary } from '@/i18n';

export default async function HomePage({ params }: PageProps<'/[locale]'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const dict = getDictionary(locale);

  return (
    <Screen>
      <Container as="header" className="flex items-center justify-end py-3">
        <LanguageSwitcher
          locale={locale}
          label={dict.language.label}
          names={{ uz: dict.language.uz, ru: dict.language.ru }}
        />
      </Container>
      <Container className="flex flex-1 flex-col gap-6 py-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{dict.home.title}</h1>
          <p className="text-lg text-muted-foreground">{dict.home.tagline}</p>
        </div>

        <section aria-labelledby="demo-price" className="flex flex-col gap-2">
          <h2 id="demo-price" className="text-sm font-medium text-muted-foreground">
            {dict.home.demoPriceHeading}
          </h2>
          <Price
            amount={12500}
            oldAmount={15000}
            locale={locale}
            currentLabel={dict.home.priceCurrentLabel}
            oldLabel={dict.home.priceOldLabel}
            className="text-2xl"
          />
        </section>

        <TelegramStatus
          label={dict.status.label}
          telegramText={dict.status.telegram}
          browserText={dict.status.browser}
        />
      </Container>
    </Screen>
  );
}
