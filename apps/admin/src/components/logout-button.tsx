'use client';

import { Button } from '@muniramarket/ui';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { useSession } from '@/lib/session';

export function LogoutButton({ className }: { className?: string }) {
  const { dict } = useI18n();
  const { logout } = useSession();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const onClick = () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    logout()
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };

  return (
    <>
      <Button
        variant="secondary"
        onClick={onClick}
        disabled={pending}
        {...(className === undefined ? {} : { className })}
      >
        {dict.header.logout}
      </Button>
      {failed ? (
        <span role="alert" className="text-sm text-red-700 dark:text-red-300">
          {dict.errors.serviceUnavailable}
        </span>
      ) : null}
    </>
  );
}
