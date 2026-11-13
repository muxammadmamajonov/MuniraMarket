'use client';

import { Button } from '@muniramarket/ui';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { updateProfile } from '@/lib/api/profile';
import {
  maskUzPhoneInput,
  nationalDigits,
  toE164,
  UZ_PHONE_PREFIX,
  validateUzPhone,
  type UzPhoneError,
} from '@/lib/profile/phone';
import { useSession } from '@/lib/session';
import { useBotStartLink } from '@/lib/telegram/bot-link';
import { BottomSheet } from '../bottom-sheet';
import { FormField } from '../form-field';
import { TelegramIcon } from '../icons';
import { FOCUS_RING, INPUT, LINK_BUTTON_PRIMARY } from '../ui-classes';
import { usePhoneShare } from './use-phone-share';

export interface PhoneSheetProps {
  open: boolean;
  onClose: () => void;
  /** Called after either path stored a number (the sheet closes itself first). */
  onDone: (how: 'shared' | 'typed') => void;
}

/**
 * Change the account phone, two ways:
 *
 * 1. Share the Telegram account's own number (Mini App `requestContact`, or the bot in a
 *    browser). This is the verified path: the bot records it and deletes the contact message.
 * 2. Type a number with the `+998 XX XXX XX XX` mask. Saved with `PATCH /me`, it is NOT verified
 *    (the API clears the verification unless it is the same number as before).
 */
export function PhoneSheet({ open, onClose, onDone }: PhoneSheetProps) {
  const { dict } = useI18n();
  const t = dict.personal;
  const p = dict.phone;
  const { apiFetch, applyUser } = useSession();
  const { webApp, phase, share, checkAgain, reset } = usePhoneShare();
  const botLink = useBotStartLink('phone');
  const [value, setValue] = useState('');
  const [error, setError] = useState<UzPhoneError | 'failed' | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (phase === 'success') {
      onDone('shared');
      reset();
    }
  }, [phase, onDone, reset]);

  const close = () => {
    setValue('');
    setError(null);
    onClose();
  };

  const save = async () => {
    const national = nationalDigits(value);
    const problem = validateUzPhone(national);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      applyUser(await updateProfile(apiFetch, { phone: toE164(national) }));
      setValue('');
      onDone('typed');
    } catch {
      setError('failed');
    } finally {
      setSaving(false);
    }
  };

  const status =
    phase === 'waiting'
      ? p.waiting
      : phase === 'cancelled'
        ? p.cancelled
        : phase === 'timeout'
          ? p.timeout
          : phase === 'unsupported'
            ? p.unsupported
            : null;

  const errorText =
    error === 'required' || error === 'incomplete'
      ? t.phoneIncomplete
      : error === 'invalid'
        ? t.phoneInvalid
        : error === 'failed'
          ? t.saveFailed
          : undefined;

  const busy = saving || phase === 'waiting';

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title={t.phoneSheetTitle}
      description={t.phoneSheetText}
      closeLabel={t.close}
      dismissible={!saving}
    >
      <div className="flex flex-col gap-4" data-testid="phone-sheet">
        {webApp !== null && phase !== 'unsupported' ? (
          <div className="flex flex-col gap-1.5">
            <Button
              size="lg"
              onClick={() => void share()}
              disabled={busy}
              data-testid="phone-share"
              className="w-full"
            >
              <TelegramIcon width={20} height={20} aria-hidden="true" />
              {phase === 'waiting' ? p.waiting : t.shareContact}
            </Button>
            <p className="text-center text-[13px] text-muted-foreground">{t.shareHint}</p>
          </div>
        ) : botLink !== null ? (
          <div className="flex flex-col gap-1.5">
            <a
              href={botLink}
              target="_blank"
              rel="noopener noreferrer"
              className={`${LINK_BUTTON_PRIMARY} w-full`}
            >
              <TelegramIcon width={20} height={20} aria-hidden="true" />
              {p.openBot}
            </a>
            <button
              type="button"
              onClick={checkAgain}
              disabled={busy}
              className={`min-h-11 rounded-xl text-sm font-semibold text-brand-ink ${FOCUS_RING}`}
            >
              {p.checkAgain}
            </button>
          </div>
        ) : null}

        <p role="status" aria-live="polite" className="text-center text-sm empty:hidden">
          {status}
        </p>

        {webApp !== null || botLink !== null ? (
          <div
            className="flex items-center gap-3 text-[13px] text-muted-foreground"
            aria-hidden="true"
          >
            <span className="h-px flex-1 bg-hairline" />
            {t.orDivider}
            <span className="h-px flex-1 bg-hairline" />
          </div>
        ) : null}

        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FormField label={t.manualLabel} hint={t.manualHint} error={errorText}>
            {(control) => (
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[17px] text-muted-foreground tabular-nums"
                >
                  {UZ_PHONE_PREFIX.trim()}
                </span>
                <input
                  {...control}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  enterKeyHint="done"
                  placeholder="90 123 45 67"
                  value={value}
                  disabled={busy}
                  data-testid="phone-manual-input"
                  onChange={(event) => {
                    setValue(maskUzPhoneInput(event.target.value));
                    if (error !== null) setError(null);
                  }}
                  className={`${INPUT} pl-[60px] text-[17px] tabular-nums`}
                />
              </div>
            )}
          </FormField>
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            disabled={busy}
            data-testid="phone-manual-save"
            className="w-full"
          >
            {saving ? t.saving : t.savePhone}
          </Button>
        </form>
      </div>
    </BottomSheet>
  );
}
