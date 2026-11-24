'use client';

import type { SavedAddress } from '@muniramarket/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatAddressLine, type Address } from '@/lib/address/address';
import {
  sameAddress,
  savedAddressTitle,
  savedToAddress,
  toSavedAddressRequest,
} from '@/lib/address/saved';
import { createSavedAddress, listSavedAddresses, MAX_SAVED_ADDRESSES } from '@/lib/api/profile';
import { useSession } from '@/lib/session';
import { AddressPicker } from './address-picker';
import { BottomSheet } from './bottom-sheet';
import { CheckIcon, PlusIcon } from './icons';
import { AddressGlyph, labelKind } from './profile/addresses-view';
import { IconTile } from './profile/settings-list';
import { FOCUS_RING } from './ui-classes';

/**
 * The signed-in customer's saved addresses for the address choosers (home card, checkout).
 * `null` until known; an anonymous visitor or a failed request simply has none, so the choosers
 * fall back to the map picker as before.
 */
export function useSavedAddresses(): {
  items: SavedAddress[] | null;
  reload: () => Promise<void>;
} {
  const { status, apiFetch } = useSession();
  const [items, setItems] = useState<SavedAddress[] | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await listSavedAddresses(apiFetch));
    } catch {
      setItems([]);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (status === 'authenticated') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the request
      void reload();
    } else if (status === 'anonymous' || status === 'error') {
      setItems([]);
    }
  }, [status, reload]);

  return { items, reload };
}

export interface AddressChooserProps {
  open: boolean;
  onClose: () => void;
  current: Address | null;
  onChoose: (address: Address) => void;
  saved: SavedAddress[] | null;
}

/**
 * Where to deliver: saved addresses first (one tap), then "New address" for the map picker. With
 * no saved addresses it is just the map picker, as before. The picker and the form are the same
 * `AddressPicker` used everywhere.
 */
export function AddressChooser({ open, onClose, current, onChoose, saved }: AddressChooserProps) {
  const { dict, locale } = useI18n();
  const t = dict.addresses;
  const [picker, setPicker] = useState(false);
  const hasSaved = saved !== null && saved.length > 0;
  const listOpen = open && hasSaved && !picker;
  const pickerOpen = open && (!hasSaved || picker);

  const close = () => {
    setPicker(false);
    onClose();
  };

  return (
    <>
      <BottomSheet open={listOpen} onClose={close} title={t.chooserTitle} closeLabel={t.close}>
        <ul data-testid="address-chooser" className="-mx-4 flex flex-col">
          {(saved ?? []).map((item) => {
            const address = savedToAddress(item);
            const selected = current !== null && sameAddress(current, address);
            const hasLabel = (item.label?.trim() ?? '') !== '';
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid="address-chooser-option"
                  aria-pressed={selected}
                  onClick={() => {
                    setPicker(false);
                    onChoose(address);
                  }}
                  className={`relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 before:absolute before:top-0 before:right-0 before:left-[58px] before:h-px before:bg-hairline first:before:hidden hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  <IconTile tone={item.is_default ? 'brand' : 'muted'}>
                    <AddressGlyph kind={labelKind(item.label)} />
                  </IconTile>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span data-user-text className="truncate text-[17px] font-medium">
                      {savedAddressTitle(item, dict.address)}
                    </span>
                    {hasLabel ? (
                      <span data-user-text className="truncate text-[15px] text-muted-foreground">
                        {formatAddressLine(address, dict.address)}
                      </span>
                    ) : null}
                  </span>
                  {selected ? (
                    <CheckIcon
                      width={20}
                      height={20}
                      strokeWidth={2.5}
                      aria-hidden="true"
                      className="shrink-0 text-primary"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              data-testid="address-chooser-new"
              onClick={() => setPicker(true)}
              className={`relative flex min-h-13 w-full items-center gap-3 px-4 py-2.5 text-left text-[17px] font-medium text-brand-ink transition-colors duration-150 before:absolute before:top-0 before:right-0 before:left-[58px] before:h-px before:bg-hairline hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
            >
              <IconTile tone="soft">
                <PlusIcon />
              </IconTile>
              {t.newAddress}
            </button>
          </li>
        </ul>
        <Link
          href={`/${locale}/profile/addresses`}
          className={`mt-2 flex min-h-11 items-center justify-center rounded-xl text-sm font-semibold text-muted-foreground ${FOCUS_RING}`}
        >
          {dict.account.addressesLink}
        </Link>
      </BottomSheet>
      <AddressPicker
        open={pickerOpen}
        onClose={close}
        initial={picker ? null : current}
        onSave={(next) => {
          setPicker(false);
          onChoose(next);
        }}
      />
    </>
  );
}

/**
 * "Save to my addresses" for an address the customer just entered: shown only when signed in,
 * when it is not saved yet and there is room. Saving it is one tap and never required.
 */
export function SaveAddressPrompt({
  address,
  saved,
  onSaved,
}: {
  address: Address | null;
  saved: SavedAddress[] | null;
  onSaved: () => void;
}) {
  const { dict } = useI18n();
  const t = dict.addresses;
  const { status, apiFetch } = useSession();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const known =
    address !== null && saved?.some((item) => sameAddress(savedToAddress(item), address));
  if (state === 'saved') {
    return (
      <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckIcon
          width={14}
          height={14}
          strokeWidth={3}
          aria-hidden="true"
          className="text-primary"
        />
        {t.savedToList}
      </p>
    );
  }
  if (
    status !== 'authenticated' ||
    address === null ||
    saved === null ||
    known === true ||
    saved.length >= MAX_SAVED_ADDRESSES
  ) {
    return null;
  }

  const save = async () => {
    setState('saving');
    try {
      await createSavedAddress(
        apiFetch,
        toSavedAddressRequest(address, { label: '', isDefault: saved.length === 0 }),
      );
      setState('saved');
      onSaved();
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void save()}
        disabled={state === 'saving'}
        data-testid="save-address-prompt"
        className={`inline-flex min-h-11 items-center gap-2 self-start rounded-xl px-1 text-sm font-semibold text-brand-ink disabled:opacity-60 ${FOCUS_RING}`}
      >
        <PlusIcon width={16} height={16} aria-hidden="true" />
        {state === 'saving' ? t.saving : t.saveForLater}
      </button>
      {state === 'failed' ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t.saveFailed}
        </p>
      ) : null}
    </div>
  );
}
