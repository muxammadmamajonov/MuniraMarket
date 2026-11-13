'use client';

import type { UpdateProfileRequest, UserPublic } from '@muniramarket/contracts';
import { Button, Skeleton } from '@muniramarket/ui';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { updateProfile } from '@/lib/api/profile';
import { isoToDisplay, parseBirthDate, type BirthDateError } from '@/lib/profile/birth-date';
import { useSession } from '@/lib/session';
import { FormField } from '../form-field';
import { CheckIcon, PhoneIcon } from '../icons';
import { SignInPrompt } from '../sign-in-prompt';
import { INPUT } from '../ui-classes';
import { BirthDateField } from './birth-date-field';
import { PhoneSheet } from './phone-sheet';
import { IconTile, SettingsGroup } from './settings-list';

/** Mirrors the Core API (`PATCH /me`). */
export const NAME_MAX = 64;

interface Draft {
  firstName: string;
  lastName: string;
  birth: string;
}

function draftOf(user: UserPublic): Draft {
  return {
    firstName: user.first_name,
    lastName: user.last_name ?? '',
    birth: isoToDisplay(user.birth_date),
  };
}

type FieldErrors = Partial<Record<'firstName' | 'lastName', 'required' | 'tooLong'>> & {
  birth?: BirthDateError;
};

/** What changed against the saved user, as a `PATCH /me` body (empty object: nothing). */
export function profileChanges(
  user: UserPublic,
  draft: Draft,
): { changes: UpdateProfileRequest; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const changes: UpdateProfileRequest = {};
  const first = draft.firstName.trim();
  const last = draft.lastName.trim();
  if (first === '') errors.firstName = 'required';
  else if (Array.from(first).length > NAME_MAX) errors.firstName = 'tooLong';
  if (Array.from(last).length > NAME_MAX) errors.lastName = 'tooLong';
  const birth = parseBirthDate(draft.birth);
  if (!birth.ok) errors.birth = birth.error;

  if (first !== user.first_name) changes.first_name = first;
  if ((last === '' ? null : last) !== (user.last_name ?? null)) {
    changes.last_name = last === '' ? null : last;
  }
  if (birth.ok && birth.iso !== (user.birth_date ?? null)) changes.birth_date = birth.iso;
  return { changes, errors };
}

/**
 * Profile › Personal details: first and last name, birthday, and the phone. One "Save" for the
 * text fields (enabled only when something changed); the phone has its own sheet because it is
 * either shared from Telegram (verified) or typed (not verified), and that state is shown with a
 * small badge rather than a warning banner.
 */
export function PersonalInfoView() {
  const { dict } = useI18n();
  const t = dict.personal;
  const { status, user, apiFetch, applyUser } = useSession();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'failed' | 'phoneSaved' | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // The form starts from the session's user once it is known (and again after a sign-in).
  const userId = user?.id ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeding the form from the session
    setDraft(user === null ? null : draftOf(user));
    // Only when the account changes, not on every refresh of the same user (keeps typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const onPhoneDone = useCallback((how: 'shared' | 'typed') => {
    setSheetOpen(false);
    setNotice(how === 'typed' ? 'phoneSaved' : 'saved');
  }, []);

  if (status === 'loading' || (status === 'authenticated' && draft === null)) {
    return (
      <div role="status" aria-label={dict.profile.checking} className="flex flex-col gap-6">
        <Skeleton className="h-56 w-full rounded-3xl bg-surface" />
        <Skeleton className="h-20 w-full rounded-3xl bg-surface" />
      </div>
    );
  }
  if (status !== 'authenticated' || user === null || draft === null) {
    return <SignInPrompt variant="screen" />;
  }

  // Dirty as typed (not only as valid changes), so Save can report a half-typed or bad date.
  const saved = draftOf(user);
  const dirty =
    draft.firstName.trim() !== saved.firstName.trim() ||
    draft.lastName.trim() !== saved.lastName.trim() ||
    draft.birth !== saved.birth;

  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setNotice(null);
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as keyof FieldErrors];
      return next;
    });
  };

  const save = async () => {
    const result = profileChanges(user, draft);
    if (Object.keys(result.errors).length > 0) {
      setErrors(result.errors);
      return;
    }
    if (Object.keys(result.changes).length === 0) return;
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateProfile(apiFetch, result.changes);
      applyUser(updated);
      setDraft(draftOf(updated));
      setNotice('saved');
    } catch {
      setNotice('failed');
    } finally {
      setSaving(false);
    }
  };

  const nameError = (kind: 'required' | 'tooLong' | undefined) =>
    kind === 'required'
      ? t.firstNameRequired
      : kind === 'tooLong'
        ? formatMessage(t.tooLong, { max: NAME_MAX })
        : undefined;

  const birthError =
    errors.birth === 'incomplete'
      ? t.birthIncomplete
      : errors.birth === 'invalid'
        ? t.birthInvalid
        : errors.birth === 'future'
          ? t.birthFuture
          : errors.birth === 'tooOld'
            ? t.birthTooOld
            : undefined;

  const verified = user.phone_verified;
  const hasPhone = user.phone_hint !== null && user.phone_hint !== undefined;

  return (
    <div data-testid="personal-info" className="flex flex-col gap-6">
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <SettingsGroup title={t.nameSection} labelledBy="personal-name">
          <div className="flex flex-col gap-4 p-4">
            <FormField label={t.firstName} required error={nameError(errors.firstName)}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="given-name"
                  enterKeyHint="next"
                  maxLength={NAME_MAX * 2}
                  value={draft.firstName}
                  disabled={saving}
                  data-testid="first-name-input"
                  onChange={(event) => edit({ firstName: event.target.value })}
                  className={INPUT}
                />
              )}
            </FormField>
            <FormField
              label={t.lastName}
              optionalLabel={t.optional}
              error={nameError(errors.lastName)}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="family-name"
                  enterKeyHint="next"
                  maxLength={NAME_MAX * 2}
                  value={draft.lastName}
                  disabled={saving}
                  data-testid="last-name-input"
                  onChange={(event) => edit({ lastName: event.target.value })}
                  className={INPUT}
                />
              )}
            </FormField>
            <FormField label={t.birthDate} optionalLabel={t.optional} error={birthError}>
              {(control) => (
                <BirthDateField
                  control={control}
                  value={draft.birth}
                  onChange={(birth) => edit({ birth })}
                  placeholder={t.birthPlaceholder}
                  disabled={saving}
                />
              )}
            </FormField>
          </div>
        </SettingsGroup>

        <Button
          type="submit"
          size="lg"
          disabled={!dirty || saving}
          data-testid="personal-save"
          className="w-full rounded-2xl"
        >
          {saving ? t.saving : t.save}
        </Button>
      </form>

      <p
        role="status"
        aria-live="polite"
        data-testid="personal-notice"
        className={`-mt-3 text-center text-sm empty:hidden ${notice === 'failed' ? 'font-medium text-danger' : 'text-muted-foreground'}`}
      >
        {notice === 'saved'
          ? t.saved
          : notice === 'phoneSaved'
            ? t.phoneSaved
            : notice === 'failed'
              ? t.saveFailed
              : ''}
      </p>

      <SettingsGroup
        title={t.phoneSection}
        labelledBy="personal-phone"
        footer={hasPhone && !verified ? t.unverifiedHint : undefined}
      >
        <div className="flex min-h-15 items-center gap-3 px-4 py-3" data-testid="phone-row">
          <IconTile tone={verified ? 'brand' : 'muted'}>
            <PhoneIcon />
          </IconTile>
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              data-money
              data-testid="phone-value"
              className={`truncate text-[17px] ${hasPhone ? '' : 'text-muted-foreground'}`}
            >
              {hasPhone ? user.phone_hint : t.phoneNone}
            </span>
            {hasPhone ? (
              <span
                data-testid="phone-state"
                data-verified={verified}
                className={`mt-0.5 inline-flex items-center gap-1 text-[13px] ${verified ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {verified ? (
                  <CheckIcon
                    width={13}
                    height={13}
                    strokeWidth={3}
                    aria-hidden="true"
                    className="text-primary"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-muted-foreground/60"
                  />
                )}
                {verified ? t.verifiedBadge : t.unverifiedBadge}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setSheetOpen(true);
            }}
            data-testid="phone-change"
            className="min-h-11 shrink-0 rounded-xl px-3 text-[15px] font-semibold text-brand-ink transition-[transform,background-color] duration-150 ease-out-strong hover:bg-surface-muted active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-focus motion-reduce:transition-none"
          >
            {hasPhone ? t.changePhone : t.addPhone}
          </button>
        </div>
      </SettingsGroup>

      <PhoneSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onDone={onPhoneDone} />
    </div>
  );
}
