import { isLocale } from '@muniramarket/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageContainer } from '@/components/page-container';
import { SiteHeader } from '@/components/site-header';
import { CARD, LINK_BUTTON_SECONDARY } from '@/components/ui-classes';
import { getDictionary } from '@/i18n';

export async function generateMetadata({ params }: PageProps<'/[locale]/help'>) {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const dict = getDictionary(locale);
  return { title: `${dict.help.title} · ${dict.meta.title}` };
}

/** How the shop works, in plain words. Only what the app really does; no invented promises. */
export default async function HelpPage({ params }: PageProps<'/[locale]/help'>) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dict = getDictionary(locale);
  const t = dict.help;

  const sections: ReadonlyArray<{ id: string; title: string; text: string }> = [
    { id: 'payment', title: t.paymentTitle, text: t.paymentText },
    { id: 'status', title: t.statusTitle, text: t.statusText },
    { id: 'phone', title: t.phoneTitle, text: t.phoneText },
    { id: 'language', title: t.languageTitle, text: t.languageText },
  ];

  return (
    <>
      <SiteHeader locale={locale} dict={dict} title={dict.pageTitles.help} />
      <main className="flex-1">
        <PageContainer className="flex max-w-2xl flex-col gap-4 py-4">
          <p className="text-muted-foreground">{t.intro}</p>

          <section aria-labelledby="help-ordering" className={`${CARD} flex flex-col gap-3`}>
            <h2 id="help-ordering" className="font-semibold">
              {t.orderingTitle}
            </h2>
            <ol className="flex flex-col gap-3">
              {t.orderingSteps.map((step, index) => (
                <li key={step} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-ink"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="help-delivery" className={`${CARD} flex flex-col gap-2`}>
            <h2 id="help-delivery" className="font-semibold">
              {t.deliveryTitle}
            </h2>
            <p className="text-muted-foreground">{t.deliveryText}</p>
            <Link href={`/${locale}`} className={`${LINK_BUTTON_SECONDARY} self-start`}>
              {t.deliveryLink}
            </Link>
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            {sections.map((section) => (
              <section
                key={section.id}
                aria-labelledby={`help-${section.id}`}
                className={`${CARD} flex flex-col gap-1`}
              >
                <h2 id={`help-${section.id}`} className="font-semibold">
                  {section.title}
                </h2>
                <p className="text-muted-foreground">{section.text}</p>
              </section>
            ))}
          </div>
        </PageContainer>
      </main>
    </>
  );
}
