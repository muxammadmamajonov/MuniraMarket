'use client';

import { Button } from '@muniramarket/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { useSession } from '@/lib/session';
import { requestContact, useTelegram } from '@/lib/telegram';
import { useBotStartLink } from '@/lib/telegram/bot-link';
import { CheckIcon, PhoneIcon } from './icons';
import { CARD, FOCUS_RING, LINK_BUTTON_PRIMARY, LINK_BUTTON_SECONDARY } from './ui-classes';

type Phase = 'idle' | 'waiting' | 'success' | 'cancelled' | 'timeout' | 'unsupported';

/** How long to wait for the bot to store the shared contact (polls `GET /auth/session`). */
export const POLL_INTERVAL_MS = 1500;
export const POLL_ATTEMPTS = 10;

export interface PhoneCardProps {
  /** `profile`: status + share/update. `checkout`: the "verify before ordering" step. */
  variant?: 'profile' | 'checkout';
}

/**
 * The account phone. It is never typed: inside the Mini App the customer shares it with
 * Telegram's own consent popup (`requestContact`), Telegram sends the contact to the bot, the bot
 * stores it through the Core API, and this card waits for the session to say `phone_verified`.
 * In a browser the same happens in the bot chat (`/start phone`).
 *
 * "Update" re-shares the Telegram account's current number; a different recipient number is a
 * per-order field at checkout, so nobody needs a code-based change here.
 */
export function PhoneCard({ variant = 'profile' }: PhoneCardProps) {
  const { dict } = useI18n();
  const t = dict.phone;
  const { user, refresh } = useSession();
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;
  const botLink = useBotStartLink('phone');
  const [phase, setPhase] = useState<Phase>('idle');
  const cancelled = useRef(false);

  useEffect(() => {
    // Re-armed on every mount: React's development double mount runs the cleanup once, and a
    // flag left `true` would silently drop every later answer from Telegram.
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const waitForVerification = useCallback(async () => {
    setPhase('waiting');
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (cancelled.current) return;
      const fresh = await refresh();
      if (fresh?.phone_verified === true) {
        setPhase('success');
        return;
      }
    }
    if (!cancelled.current) setPhase('timeout');
  }, [refresh]);

  const share = useCallback(async () => {
    const outcome = await requestContact(webApp);
    if (cancelled.current) return;
    if (outcome === 'shared') void waitForVerification();
    else setPhase(outcome);
  }, [webApp, waitForVerification]);

  if (user === null) return null;
  const verified = user.phone_verified;
  if (variant === 'checkout' && verified) return null;

  const heading = variant === 'checkout' ? t.checkoutTitle : t.heading;
  const status =
    phase === 'waiting'
      ? t.waiting
      : phase === 'success'
        ? t.success
        : phase === 'cancelled'
          ? t.cancelled
          : phase === 'timeout'
            ? t.timeout
            : phase === 'unsupported'
              ? t.unsupported
              : null;

  const primaryLabel = verified ? t.update : t.share;
  const busy = phase === 'waiting';

  let action: React.ReactNode;
  if (webApp !== null && phase !== 'unsupported') {
    action = (
      <Button
        variant={verified ? 'secondary' : 'primary'}
        disabled={busy}
        onClick={() => void share()}
        className="w-full sm:w-auto"
      >
        {busy ? t.waiting : primaryLabel}
      </Button>
    );
  } else if (botLink !== null) {
    action = (
      <a
        href={botLink}
        target="_blank"
        rel="noopener noreferrer"
        className={`${verified ? LINK_BUTTON_SECONDARY : LINK_BUTTON_PRIMARY} w-full sm:w-auto`}
      >
        {t.openBot}
      </a>
    );
  } else {
    action = <p className="text-sm text-muted-foreground">{t.openInTelegram}</p>;
  }

  return (
    <section
      aria-labelledby={`phone-${variant}`}
      data-testid={`phone-card-${variant}`}
      className={`${CARD} flex flex-col gap-3 ${variant === 'checkout' ? 'bg-brand-soft' : ''}`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground"
        >
          <PhoneIcon width={20} height={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={`phone-${variant}`} className="font-semibold">
            {heading}
          </h2>
          {verified && user.phone_hint ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span data-money className="text-base font-medium">
                {user.phone_hint}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-semibold text-foreground">
                <CheckIcon width={12} height={12} aria-hidden="true" />
                {t.verified}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {variant === 'checkout' ? t.checkoutText : t.why}
            </p>
          )}
        </div>
      </div>
      {verified && variant === 'profile' ? (
        <p className="text-sm text-muted-foreground">{t.updateHint}</p>
      ) : null}
      {webApp === null && botLink !== null ? (
        <p className="text-sm text-muted-foreground">{t.browserHint}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {action}
        {phase === 'timeout' || (webApp === null && botLink !== null) ? (
          <button
            type="button"
            onClick={() => void waitForVerification()}
            disabled={busy}
            className={`min-h-11 rounded-xl px-3 text-sm font-semibold text-brand-ink underline-offset-4 hover:underline ${FOCUS_RING}`}
          >
            {t.checkAgain}
          </button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-sm empty:hidden">
        {status}
      </p>
    </section>
  );
}
