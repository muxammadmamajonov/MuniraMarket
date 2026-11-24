'use client';

import type { SavedAddress } from '@muniramarket/contracts';
import { ErrorState, Skeleton } from '@muniramarket/ui';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { useI18n } from '@/i18n/context';
import type { Dictionary } from '@/i18n';
import { ru } from '@/i18n/dictionaries/ru';
import { uz } from '@/i18n/dictionaries/uz';
import { formatMessage } from '@/i18n/format';
import { formatAddressLine } from '@/lib/address/address';
import { savedAddressTitle, savedToAddress } from '@/lib/address/saved';
import { ApiRequestError } from '@/lib/api/errors';
import { deleteSavedAddress, listSavedAddresses, MAX_SAVED_ADDRESSES } from '@/lib/api/profile';
import { useSession } from '@/lib/session';
import { EmptyPanel } from '../empty-panel';
import { BriefcaseIcon, ChevronRightIcon, HomeIcon, PinIcon, PlusIcon } from '../icons';
import { SignInPrompt } from '../sign-in-prompt';
import { FOCUS_RING, GROUP, LINK_BUTTON_PRIMARY } from '../ui-classes';
import { IconTile } from './settings-list';
import { SwipeRow } from './swipe-row';

type Load = { kind: 'loading' } | { kind: 'ready'; items: SavedAddress[] } | { kind: 'failed' };

/** The tile glyph follows the label: home, work, or a plain pin for anything else. */
export function labelKind(
  label: string | null,
  dicts: readonly Dictionary[] = [uz, ru],
): 'home' | 'work' | 'other' {
  const value = label?.trim().toLocaleLowerCase() ?? '';
  if (value === '') return 'other';
  if (dicts.some((d) => d.addresses.labelHome.toLocaleLowerCase() === value)) return 'home';
  if (dicts.some((d) => d.addresses.labelWork.toLocaleLowerCase() === value)) return 'work';
  return 'other';
}

export function AddressGlyph({ kind }: { kind: 'home' | 'work' | 'other' }) {
  return kind === 'home' ? <HomeIcon /> : kind === 'work' ? <BriefcaseIcon /> : <PinIcon />;
}

/**
 * Profile › My addresses: the saved delivery addresses (default first). Tap a row to edit it;
 * swipe it left (or Tab to its delete button) to delete. "Add address" opens the editor with the
 * same map picker and form as checkout.
 */
export function AddressesView() {
  const { dict, locale } = useI18n();
  const t = dict.addresses;
  const { status, apiFetch, retry } = useSession();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<'deleted' | 'failed' | null>(null);
  const hintId = useId();

  const fetchAll = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      setLoad({ kind: 'ready', items: await listSavedAddresses(apiFetch) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'session_required') retry();
      setLoad({ kind: 'failed' });
    }
  }, [apiFetch, retry]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the request
    void fetchAll();
  }, [status, fetchAll]);

  const remove = async (address: SavedAddress) => {
    if (load.kind !== 'ready') return;
    const before = load.items;
    setOpenId(null);
    // Optimistic: the row is gone at once; it comes back if the API refuses.
    setLoad({ kind: 'ready', items: before.filter((item) => item.id !== address.id) });
    try {
      await deleteSavedAddress(apiFetch, address.id);
      setNotice('deleted');
      // The API may have promoted another address to default: show its truth.
      setLoad({ kind: 'ready', items: await listSavedAddresses(apiFetch) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'address_not_found') {
        setNotice('deleted');
        return;
      }
      setLoad({ kind: 'ready', items: before });
      setNotice('failed');
    }
  };

  if (status === 'loading' || (status === 'authenticated' && load.kind === 'loading')) {
    return (
      <div role="status" aria-label={t.loading} className={`${GROUP} flex flex-col gap-5 p-4`}>
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-[30px] rounded-[9px]" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (status !== 'authenticated') return <SignInPrompt variant="screen" />;
  if (load.kind === 'failed') {
    return <ErrorState title={t.loadFailed} retryLabel={t.retry} onRetry={() => void fetchAll()} />;
  }
  if (load.kind !== 'ready') return null;

  const items = load.items;
  const addHref = `/${locale}/profile/addresses/new`;
  const full = items.length >= MAX_SAVED_ADDRESSES;
  const status_ = (
    <p
      role="status"
      aria-live="polite"
      data-testid="addresses-notice"
      className={`text-center text-sm empty:hidden ${notice === 'failed' ? 'font-medium text-danger' : 'text-muted-foreground'}`}
    >
      {notice === 'deleted' ? t.deleted : notice === 'failed' ? t.deleteFailed : ''}
    </p>
  );

  if (items.length === 0) {
    return (
      <>
        <EmptyPanel
          icon={<PinIcon />}
          title={t.emptyTitle}
          description={t.emptyHint}
          action={
            <Link href={addHref} className={LINK_BUTTON_PRIMARY} data-testid="address-add">
              <PlusIcon width={20} height={20} aria-hidden="true" />
              {t.add}
            </Link>
          }
        />
        {status_}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p id={hintId} className="sr-only">
        {t.rowActionsHint}
      </p>
      <ul
        aria-label={dict.pageTitles.addresses}
        aria-describedby={hintId}
        data-testid="address-list"
        className={`${GROUP} flex flex-col overflow-hidden`}
      >
        {items.map((item) => {
          const title = savedAddressTitle(item, dict.address);
          const hasLabel = (item.label?.trim() ?? '') !== '';
          const line = formatAddressLine(savedToAddress(item), dict.address);
          return (
            <li
              key={item.id}
              data-testid="address-row"
              className="relative before:absolute before:top-0 before:right-0 before:left-[58px] before:z-10 before:h-px before:bg-hairline first:before:hidden"
            >
              <SwipeRow
                open={openId === item.id}
                onOpenChange={(next) => setOpenId(next ? item.id : null)}
                onDelete={() => void remove(item)}
                deleteLabel={t.delete}
                deleteAccessibleName={formatMessage(t.deleteNamed, { label: title })}
              >
                <Link
                  href={`/${locale}/profile/addresses/${encodeURIComponent(item.id)}`}
                  draggable={false}
                  className={`flex min-h-16 items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  <IconTile tone={item.is_default ? 'brand' : 'muted'}>
                    <AddressGlyph kind={labelKind(item.label)} />
                  </IconTile>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span data-user-text className="truncate text-[17px] font-medium">
                        {title}
                      </span>
                      {item.is_default ? (
                        <span
                          data-testid="address-default"
                          className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] leading-4 font-semibold tracking-[0.02em] text-brand-ink uppercase"
                        >
                          {t.isDefault}
                        </span>
                      ) : null}
                    </span>
                    {hasLabel ? (
                      <span data-user-text className="truncate text-[15px] text-muted-foreground">
                        {line}
                      </span>
                    ) : item.landmark ? (
                      <span data-user-text className="truncate text-[15px] text-muted-foreground">
                        {item.landmark}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    width={18}
                    height={18}
                    className="shrink-0 text-muted-foreground/70"
                  />
                </Link>
              </SwipeRow>
            </li>
          );
        })}
        <li className="relative before:absolute before:top-0 before:right-0 before:left-[58px] before:h-px before:bg-hairline">
          {full ? (
            <p className="px-4 py-3.5 text-[15px] text-muted-foreground">
              {formatMessage(t.limitReached, { max: MAX_SAVED_ADDRESSES })}
            </p>
          ) : (
            <Link
              href={addHref}
              data-testid="address-add"
              className={`flex min-h-13 items-center gap-3 px-4 py-2.5 text-[17px] font-medium text-brand-ink transition-colors duration-150 hover:bg-surface-muted active:bg-surface-muted ${FOCUS_RING} focus-visible:-outline-offset-2`}
            >
              <IconTile tone="soft">
                <PlusIcon />
              </IconTile>
              {t.add}
            </Link>
          )}
        </li>
      </ul>
      {status_}
    </div>
  );
}
