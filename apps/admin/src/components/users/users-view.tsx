'use client';

import type { AdminUser, AdminUserPage, UserRole } from '@muniramarket/contracts';
import { USER_ROLES } from '@muniramarket/contracts';
import { Button, EmptyState } from '@muniramarket/ui';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { writeErrorMessage } from '@/lib/api/error-messages';
import { jsonInit, request } from '@/lib/api/request';
import { formatCount } from '@/lib/format';
import { LIST_PAGE_SIZE, parseChoice, parsePageParam, parseText } from '@/lib/list-params';
import { useSession } from '@/lib/session';
import { useApiResource } from '@/lib/use-api-resource';
import { useUrlParams } from '@/lib/use-url-params';
import { Alert } from '../ui/alert';
import { CHIP, CHIP_OFF, CHIP_ON, INPUT } from '../ui/classes';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { DataTable, type Column } from '../ui/data-table';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { Pagination } from '../ui/pagination';
import { ResourceView } from '../ui/resource-view';
import { SearchBox } from '../ui/search-box';

const BLOCKED_CHOICES = ['all', 'blocked', 'active'] as const;
type BlockedChoice = (typeof BLOCKED_CHOICES)[number];

/** Display name: first + last name, or the Telegram id when there is none. Never a phone number. */
export function userDisplayName(user: AdminUser, fallback: string): string {
  const name = [user.first_name, user.last_name ?? ''].join(' ').trim();
  return name === '' ? `${fallback} ${String(user.telegram_user_id)}` : name;
}

function RoleDialog({
  user,
  opener,
  onClose,
  onDone,
}: {
  user: AdminUser;
  opener: HTMLElement | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { dict, locale } = useI18n();
  const copy = dict.users.roleDialog;
  const { apiFetch } = useSession();
  const [role, setRole] = useState<UserRole>(user.role);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flying = useRef(false);
  const select = useRef<HTMLSelectElement>(null);
  const same = role === user.role;

  const submit = async () => {
    if (flying.current || same) return;
    flying.current = true;
    setPending(true);
    setError(null);
    const result = await request<AdminUser>(
      apiFetch,
      `/admin/users/${encodeURIComponent(user.id)}`,
      jsonInit('PATCH', { role }),
    );
    flying.current = false;
    setPending(false);
    if (result.ok) onDone();
    else setError(writeErrorMessage(dict, locale, result.error));
  };

  return (
    <Modal
      title={copy.title}
      description={formatMessage(copy.description, {
        name: userDisplayName(user, dict.users.telegramId),
      })}
      onClose={onClose}
      dismissible={!pending}
      returnFocusTo={opener}
      initialFocusRef={select}
    >
      <label className="flex flex-col gap-1.5 font-medium">
        {copy.select}
        <select
          ref={select}
          value={role}
          disabled={pending}
          data-testid="role-select"
          onChange={(event) => setRole(event.target.value as UserRole)}
          className={INPUT}
        >
          {USER_ROLES.map((item) => (
            <option key={item} value={item}>
              {dict.roles[item]}
            </option>
          ))}
        </select>
      </label>
      {same ? (
        <p className="text-sm text-muted-foreground">
          {formatMessage(copy.unchanged, { role: dict.roles[user.role] })}
        </p>
      ) : null}
      {error === null ? null : <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          {dict.common.cancel}
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={pending || same}
          data-testid="confirm-action"
        >
          {pending ? dict.common.saving : copy.confirm}
        </Button>
      </div>
    </Modal>
  );
}

type DialogState =
  | { kind: 'role'; user: AdminUser; opener: HTMLElement | null }
  | { kind: 'block'; user: AdminUser; opener: HTMLElement | null };

/** Users: search, role/blocked filters, change role and block/unblock (both with confirmation). */
export function UsersView() {
  const { dict, locale } = useI18n();
  const copy = dict.users;
  const { apiFetch } = useSession();
  const { params, replace, hrefWith } = useUrlParams();

  const q = parseText(params.get('q'));
  const role = parseChoice(params.get('role'), USER_ROLES);
  const blocked: BlockedChoice = parseChoice(params.get('blocked'), BLOCKED_CHOICES) ?? 'all';
  const page = parsePageParam(params.get('page'));

  const query = new URLSearchParams({ page: String(page), page_size: String(LIST_PAGE_SIZE) });
  if (q !== '') query.set('q', q);
  if (role !== null) query.set('role', role);
  if (blocked !== 'all') query.set('blocked', blocked === 'blocked' ? 'true' : 'false');

  const resource = useApiResource<AdminUserPage>(`/admin/users?${query.toString()}`);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const changeBlock = async (user: AdminUser): Promise<string | null> => {
    const result = await request<AdminUser>(
      apiFetch,
      `/admin/users/${encodeURIComponent(user.id)}`,
      jsonInit('PATCH', { is_blocked: !user.is_blocked }),
    );
    if (!result.ok) return writeErrorMessage(dict, locale, result.error);
    setNotice(user.is_blocked ? copy.unblocked : copy.blocked);
    resource.reload();
    return null;
  };

  const columns: Array<Column<AdminUser>> = [
    {
      id: 'user',
      header: copy.columns.user,
      primary: true,
      cell: (user) => (
        <>
          <span className="block font-semibold">{userDisplayName(user, copy.telegramId)}</span>
          <span className="block text-sm text-muted-foreground">
            {user.username === null || user.username === '' ? null : <>@{user.username} · </>}
            {copy.telegramId}: <span className="font-mono tabular">{user.telegram_user_id}</span>
          </span>
        </>
      ),
    },
    { id: 'role', header: copy.columns.role, nowrap: true, cell: (user) => dict.roles[user.role] },
    {
      id: 'status',
      header: copy.columns.status,
      nowrap: true,
      cell: (user) => (
        <span
          data-blocked={user.is_blocked}
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium whitespace-nowrap ${
            user.is_blocked
              ? 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200'
              : 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200'
          }`}
        >
          {user.is_blocked ? copy.blockedBadge : copy.activeBadge}
        </span>
      ),
    },
    {
      id: 'actions',
      header: copy.columns.actions,
      bare: true,
      cell: (user) => {
        const name = userDisplayName(user, copy.telegramId);
        return (
          <span className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              aria-label={`${copy.changeRole}: ${name}`}
              data-testid="change-role"
              onClick={(event) => setDialog({ kind: 'role', user, opener: event.currentTarget })}
            >
              {copy.changeRole}
            </Button>
            <Button
              variant="secondary"
              aria-label={`${user.is_blocked ? copy.unblock : copy.block}: ${name}`}
              data-testid="toggle-block"
              onClick={(event) => setDialog({ kind: 'block', user, opener: event.currentTarget })}
            >
              {user.is_blocked ? copy.unblock : copy.block}
            </Button>
          </span>
        );
      },
    },
  ];

  const filtered = q !== '' || role !== null || blocked !== 'all';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={copy.title} />
      {notice === null ? null : <Alert tone="success">{notice}</Alert>}

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox
          value={q}
          onSearch={(next) => replace({ q: next })}
          label={copy.searchLabel}
          placeholder={copy.searchPlaceholder}
          testId="user-search"
        />
      </div>

      <nav aria-label={copy.roleFilterLabel}>
        <ul className="flex flex-wrap gap-2">
          {[null, ...USER_ROLES].map((choice) => (
            <li key={choice ?? 'all'}>
              <Link
                href={hrefWith({ role: choice })}
                replace
                aria-current={choice === role ? 'true' : undefined}
                className={`${CHIP} ${choice === role ? CHIP_ON : CHIP_OFF}`}
              >
                {choice === null ? dict.common.all : dict.roles[choice]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <nav aria-label={copy.blockedFilterLabel}>
        <ul className="flex flex-wrap gap-2">
          {BLOCKED_CHOICES.map((choice) => (
            <li key={choice}>
              <Link
                href={hrefWith({ blocked: choice === 'all' ? null : choice })}
                replace
                aria-current={choice === blocked ? 'true' : undefined}
                className={`${CHIP} ${choice === blocked ? CHIP_ON : CHIP_OFF}`}
              >
                {copy.blockedChoices[choice]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <ResourceView resource={resource} loadingLabel={copy.loading}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={filtered ? copy.emptyFiltered : copy.empty} />
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground tabular">
                {formatMessage(dict.common.total, { count: formatCount(data.total) })}
              </p>
              <DataTable
                caption={copy.table}
                columns={columns}
                rows={data.items}
                rowKey={(user) => user.id}
                rowTestId="user-row"
              />
              <Pagination
                page={page}
                totalPages={data.total_pages}
                hrefFor={(target) => hrefWith({ page: target > 1 ? String(target) : null })}
              />
            </div>
          )
        }
      </ResourceView>

      {dialog?.kind === 'role' ? (
        <RoleDialog
          user={dialog.user}
          opener={dialog.opener}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setNotice(copy.roleChanged);
            resource.reload();
          }}
        />
      ) : null}
      {dialog?.kind === 'block' ? (
        <ConfirmDialog
          title={dialog.user.is_blocked ? copy.unblockDialog.title : copy.blockDialog.title}
          description={formatMessage(
            dialog.user.is_blocked ? copy.unblockDialog.description : copy.blockDialog.description,
            { name: userDisplayName(dialog.user, copy.telegramId) },
          )}
          confirmLabel={
            dialog.user.is_blocked ? copy.unblockDialog.confirm : copy.blockDialog.confirm
          }
          tone={dialog.user.is_blocked ? 'primary' : 'danger'}
          onConfirm={() => changeBlock(dialog.user)}
          onClose={() => setDialog(null)}
          returnFocusTo={dialog.opener}
        />
      ) : null}
    </div>
  );
}
