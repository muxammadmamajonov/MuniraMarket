'use client';

import { useTelegram } from '@/lib/telegram';

export interface TelegramStatusProps {
  label: string;
  telegramText: string;
  browserText: string;
}

/** Shows whether the page runs inside Telegram. Detected on the client after hydration. */
export function TelegramStatus({ label, telegramText, browserText }: TelegramStatusProps) {
  const telegram = useTelegram();

  return (
    <p className="text-sm text-muted-foreground" data-testid="telegram-status">
      {label}:{' '}
      <strong className="font-semibold text-foreground">
        {telegram.kind === 'telegram' ? telegramText : browserText}
      </strong>
    </p>
  );
}
