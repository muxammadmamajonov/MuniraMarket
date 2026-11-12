'use client';

import type { SavedAddress } from '@muniramarket/contracts';
import { Button, ErrorState, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { formatAddressLine, isCompleteAddress, type Address } from '@/lib/address/address';
import { ADDRESS_LABEL_MAX, savedToAddress, toSavedAddressRequest } from '@/lib/address/saved';
import { ApiRequestError } from '@/lib/api/errors';
import {
  createSavedAddress,
  deleteSavedAddress,
  listSavedAddresses,
  MAX_SAVED_ADDRESSES,
  updateSavedAddress,
} from '@/lib/api/profile';
import { canGoBack } from '@/lib/back-navigation';
import { useSession } from '@/lib/session';
import { AddressPicker } from '../address-picker';
import { BottomSheet } from '../bottom-sheet';
import { BriefcaseIcon, HomeIcon, MapIcon, PinIcon } from '../icons';
import { SignInPrompt } from '../sign-in-prompt';
import { FOCUS_RING, GROUP, INPUT, LINK_BUTTON_PRIMARY, PRESS } from '../ui-classes';
import { IconTile, SettingsGroup, Switch } from './settings-list';
import { labelKind } from './addresses-view';

type LabelChoice = 'home' | 'work' | 'other';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; existing: SavedAddress | null; count: number }
  | { kind: 'missing' }
  | { kind: 'failed' };

type Notice = 'limit' | 'failed' | 'deleteFailed' | 'needPoint' | null;

/**
 * Profile › My addresses › one address (or a new one). The point and the door details are edited
 * with the SAME map picker and form as checkout (`AddressPicker`); this page adds what only a
 * saved address has: a name (Home / Work / your own) and whether it is the default.
 */
export function AddressEditorView({ addressId }: { addressId: string | null }) {
  const { dict, locale } = useI18n();
  const t = dict.addresses;
  const router = useRouter();
  const { status, apiFetch, retry } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [address, setAddress] = useState<Address | null>(null);
  const [choice, setChoice] = useState<LabelChoice>('home');
  const [customLabel, setCustomLabel] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<'saving' | 'deleting' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const listHref = `/${locale}/profile/addresses`;

  const fetchExisting = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const items = await listSavedAddresses(apiFetch);
      if (addressId === null) {
        setLoad({ kind: 'ready', existing: null, count: items.length });
        setIsDefault(items.length === 0);
        return;
      }
      const existing = items.find((item) => item.id === addressId) ?? null;
      if (existing === null) {
        setLoad({ kind: 'missing' });
        return;
      }
      setAddress(savedToAddress(existing));
      const kind = labelKind(existing.label);
      setChoice(kind);
      setCustomLabel(kind === 'other' ? (existing.label ?? '') : '');
      setIsDefault(existing.is_default);
      setLoad({ kind: 'ready', existing, count: items.length });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, addressId, retry]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the request
    void fetchExisting();
  }, [status, fetchExisting]);

  const leave = useCallback(() => {
    if (canGoBack()) router.back();
    else router.replace(listHref);
  }, [router, listHref]);

  if (status === 'loading' || (status === 'authenticated' && load.kind === 'loading')) {
    return (
      <div role="status" aria-label={t.loading} className="flex flex-col gap-6">
        <Skeleton className="h-24 w-full rounded-3xl bg-surface" />
        <Skeleton className="h-28 w-full rounded-3xl bg-surface" />
      </div>
    );
  }
  if (status !== 'authenticated') return <SignInPrompt variant="screen" />;
  if (load.kind === 'failed') {
    return (
      <ErrorState title={t.loadFailed} retryLabel={t.retry} onRetry={() => void fetchExisting()} />
    );
  }
  if (load.kind === 'missing') {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <p className="text-lg font-semibold">{t.notFound}</p>
        <Link href={listHref} className={LINK_BUTTON_PRIMARY}>
          {dict.pageTitles.addresses}
        </Link>
      </div>
    );
  }
  if (load.kind !== 'ready') return null;

  const existing = load.existing;
  const atLimit = existing === null && load.count >= MAX_SAVED_ADDRESSES;
  const label =
    choice === 'home' ? t.labelHome : choice === 'work' ? t.labelWork : customLabel.trim();

  const save = async () => {
    if (!isCompleteAddress(address)) {
      setNotice('needPoint');
      return;
    }
    setBusy('saving');
    setNotice(null);
    const request = toSavedAddressRequest(address, {
      label,
      // Omitted on an existing non-default address the switch was not touched for.
      isDefault: existing === null || isDefault !== existing.is_default ? isDefault : undefined,
    });
    try {
      if (existing === null) await createSavedAddress(apiFetch, request);
      else await updateSavedAddress(apiFetch, existing.id, request);
      leave();
    } catch (error) {
      setBusy(null);
      setNotice(
        error instanceof ApiRequestError && error.code === 'address_limit_reached'
          ? 'limit'
          : 'failed',
      );
    }
  };

  const remove = async () => {
    if (existing === null) return;
    setBusy('deleting');
    try {
      await deleteSavedAddress(apiFetch, existing.id);
      setConfirmOpen(false);
      leave();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'address_not_found') {
        leave();
        return;
      }
      setBusy(null);
      setConfirmOpen(false);
      setNotice('deleteFailed');
    }
  };

  const chips: { id: LabelChoice; text: string; icon: React.ReactNode }[] = [
    { id: 'home', text: t.labelHome, icon: <HomeIcon width={18} height={18} /> },
    { id: 'work', text: t.labelWork, icon: <BriefcaseIcon width={18} height={18} /> },
    { id: 'other', text: t.labelOther, icon: <PinIcon width={18} height={18} /> },
  ];

  const line = address === null ? null : formatAddressLine(address, dict.address);
  const noticeText =
    notice === 'limit' || atLimit
      ? formatMessage(t.limitReached, { max: MAX_SAVED_ADDRESSES })
      : notice === 'failed'
        ? t.saveFailed
        : notice === 'deleteFailed'
          ? t.deleteFailed
          : notice === 'needPoint'
            ? t.needPoint
            : '';

  return (
    <div data-testid="address-editor" className="flex flex-col gap-6">
      <SettingsGroup title={t.pointSection} labelledBy="address-point">
        {address === null || line === null ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            data-testid="address-choose-on-map"
            className={`flex min-h-24 flex-col items-center justify-center gap-2 p-4 text-[17px] font-semibold text-brand-ink transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
          >
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-full bg-brand-soft"
            >
              <MapIcon width={24} height={24} />
            </span>
            {t.chooseOnMap}
          </button>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-start gap-3 p-4" data-testid="address-summary">
              <IconTile tone="brand">
                <PinIcon />
              </IconTile>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p
                  data-user-text
                  className="text-[17px] leading-[22px] font-medium [overflow-wrap:anywhere]"
                >
                  {line}
                </p>
                {address.landmark.trim() === '' ? null : (
                  <p
                    data-user-text
                    className="text-[15px] text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {address.landmark}
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              data-testid="address-change-on-map"
              className={`relative flex min-h-12 items-center justify-center gap-2 px-4 text-[15px] font-semibold text-brand-ink transition-colors duration-150 before:absolute before:top-0 before:right-0 before:left-4 before:h-px before:bg-hairline hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
            >
              <MapIcon width={18} height={18} aria-hidden="true" />
              {t.changeOnMap}
            </button>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t.labelSection} labelledBy="address-label">
        <div className="flex flex-col gap-3 p-4">
          <div role="radiogroup" aria-labelledby="address-label" className="grid grid-cols-3 gap-2">
            {chips.map((chip) => {
              const active = chip.id === choice;
              return (
                <button
                  key={chip.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`address-label-${chip.id}`}
                  onClick={() => setChoice(chip.id)}
                  className={`flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-2xl px-2 text-[15px] font-semibold ${PRESS} ${FOCUS_RING} ${
                    active
                      ? 'bg-foreground text-background'
                      : 'bg-surface-muted text-foreground hover:bg-border'
                  }`}
                >
                  <span aria-hidden="true" className="shrink-0">
                    {chip.icon}
                  </span>
                  <span className="truncate">{chip.text}</span>
                </button>
              );
            })}
          </div>
          {choice === 'other' ? (
            <input
              type="text"
              aria-label={t.labelSection}
              placeholder={t.labelPlaceholder}
              maxLength={ADDRESS_LABEL_MAX}
              value={customLabel}
              onChange={(event) => setCustomLabel(event.target.value)}
              data-testid="address-label-input"
              className={INPUT}
            />
          ) : null}
        </div>
      </SettingsGroup>

      <div className={`${GROUP} flex min-h-13 items-center gap-3 px-4 py-2.5`}>
        <span id="address-default-label" className="min-w-0 flex-1 text-[17px]">
          {t.makeDefault}
        </span>
        <Switch
          checked={isDefault}
          onChange={setIsDefault}
          label={t.makeDefault}
          disabled={busy !== null}
          testId="address-default-switch"
        />
      </div>

      <div className="flex flex-col gap-3">
        <Button
          size="lg"
          onClick={() => void save()}
          disabled={busy !== null || atLimit}
          data-testid="address-save"
          className="w-full rounded-2xl"
        >
          {busy === 'saving' ? t.saving : t.save}
        </Button>
        <p
          role="status"
          aria-live="polite"
          data-testid="address-notice"
          className="text-center text-sm font-medium text-danger empty:hidden"
        >
          {noticeText}
        </p>
        {existing === null ? null : (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={busy !== null}
            data-testid="address-delete"
            className={`min-h-12 rounded-2xl bg-surface text-[17px] font-semibold text-danger transition-colors duration-150 hover:bg-danger-soft active:bg-danger-soft disabled:opacity-50 ${FOCUS_RING}`}
          >
            {t.delete}
          </button>
        )}
      </div>

      <AddressPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        initial={address}
        onSave={(next) => {
          setAddress(next);
          setPickerOpen(false);
          if (notice === 'needPoint') setNotice(null);
        }}
      />

      <BottomSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t.deleteTitle}
        description={t.deleteText}
        closeLabel={t.close}
        dismissible={busy === null}
      >
        <div className="flex flex-col gap-2">
          <Button
            variant="danger"
            size="lg"
            onClick={() => void remove()}
            disabled={busy !== null}
            data-testid="address-delete-confirm"
            className="w-full rounded-2xl"
          >
            {t.delete}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => setConfirmOpen(false)}
            disabled={busy !== null}
            className="w-full rounded-2xl"
            data-autofocus
          >
            {t.keep}
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
