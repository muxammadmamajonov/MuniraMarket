'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/lib/session';
import { requestContact, useTelegram } from '@/lib/telegram';

export type SharePhase = 'idle' | 'waiting' | 'success' | 'cancelled' | 'timeout' | 'unsupported';

/** How long to wait for the bot to store the shared contact (polls `GET /auth/session`). */
export const POLL_INTERVAL_MS = 1500;
export const POLL_ATTEMPTS = 10;

/**
 * Sharing the Telegram account's own number: `WebApp.requestContact()` shows Telegram's consent
 * popup, Telegram sends the contact to the bot, the bot records it through the Core API (which
 * marks it verified) and deletes the contact message from the chat. This page never sees the
 * number; it polls the session until `phone_verified` turns true.
 *
 * `previousHint` is the phone hint before sharing: when the account already had a verified number
 * the poll waits for the hint to change too, so a re-share of a different number is not reported
 * as done before the bot has stored it.
 */
export function usePhoneShare() {
  const { refresh, user } = useSession();
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;
  const [phase, setPhase] = useState<SharePhase>('idle');
  const cancelled = useRef(false);

  useEffect(() => {
    // Re-armed on every mount: React's development double mount runs the cleanup once.
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const waitForVerification = useCallback(
    async (before: { verified: boolean; hint: string | null }) => {
      setPhase('waiting');
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled.current) return;
        const fresh = await refresh();
        const changed = !before.verified || fresh?.phone_hint !== before.hint;
        if (fresh?.phone_verified === true && changed) {
          setPhase('success');
          return;
        }
      }
      // The same number re-shared: verified all along, the hint never changes. Done.
      if (!cancelled.current) setPhase(before.verified ? 'success' : 'timeout');
    },
    [refresh],
  );

  const share = useCallback(async () => {
    const before = { verified: user?.phone_verified === true, hint: user?.phone_hint ?? null };
    const outcome = await requestContact(webApp);
    if (cancelled.current) return;
    if (outcome === 'shared') void waitForVerification(before);
    else setPhase(outcome);
  }, [webApp, user, waitForVerification]);

  const checkAgain = useCallback(
    () =>
      void waitForVerification({
        verified: false,
        hint: null,
      }),
    [waitForVerification],
  );

  return { webApp, phase, share, checkAgain, reset: () => setPhase('idle') };
}
