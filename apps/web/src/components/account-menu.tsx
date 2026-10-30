'use client';

import { Button } from '@muniramarket/ui';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { useSession } from '@/lib/session';
import { useTelegram } from '@/lib/telegram';

/**
 * Signed-in name and a logout button. The button is only offered in a regular browser: inside the
 * Mini App the session is tied to the Telegram account and is re-established on every open, so
 * logging out there would only leave the user stuck.
 */
export function AccountMenu() {
  const { dict } = useI18n();
  const { status, user, logout } = useSession();
  const telegram = useTelegram();
  const [pending, setPending] = useState(false);

  if (status !== 'authenticated' || user === null || telegram.kind === 'telegram') return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="hidden text-muted-foreground sm:inline">
        {formatMessage(dict.auth.signedInAs, { name: user.first_name })}
      </span>
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => {
          setPending(true);
          // A failed logout leaves the session in place; the button simply becomes usable again.
          void logout()
            .catch(() => undefined)
            .finally(() => setPending(false));
        }}
      >
        {dict.auth.logout}
      </Button>
    </div>
  );
}
