'use client';

import type { AuditEntry, AuditPage } from '@muniramarket/contracts';
import { EmptyState } from '@muniramarket/ui';
import Link from 'next/link';
import { useI18n } from '@/i18n/context';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditAction,
  type AuditEntityType,
} from '@/i18n/dictionaries/sections/audit';
import { formatMessage } from '@/i18n/format';
import { auditDetailLines } from '@/lib/audit';
import { formatCount, formatDateTime } from '@/lib/format';
import { parseChoice, parsePageParam } from '@/lib/list-params';
import { useApiResource } from '@/lib/use-api-resource';
import { useUrlParams } from '@/lib/use-url-params';
import { INPUT } from '../ui/classes';
import { DataTable, type Column } from '../ui/data-table';
import { PageHeader } from '../ui/page-header';
import { Pagination } from '../ui/pagination';
import { ResourceView } from '../ui/resource-view';

const AUDIT_PAGE_SIZE = 25;

function Details({ entry }: { entry: AuditEntry }) {
  const { dict } = useI18n();
  const copy = dict.audit;
  const lines = auditDetailLines(entry.details);
  if (lines.length === 0) return <span className="text-muted-foreground">{copy.noDetails}</span>;
  const extra: Record<string, string | undefined> = copy.extra;
  const show = (value: string | number | boolean | null | undefined): string => {
    if (value === null || value === undefined || value === '') return dict.common.noValue;
    if (typeof value === 'boolean') return value ? dict.common.yes : dict.common.no;
    return String(value);
  };
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {lines.map((line) => (
        <li
          key={`${line.change ? 'c' : 'x'}-${line.key}`}
          className="break-words [overflow-wrap:anywhere]"
        >
          <span className="font-mono text-muted-foreground">
            {line.change ? line.key : (extra[line.key] ?? line.key)}
          </span>
          :{' '}
          {line.change ? (
            <>
              <span>{show(line.from)}</span> {copy.arrow}{' '}
              <span className="font-medium">{show(line.to)}</span>
            </>
          ) : (
            <span>{show(line.to)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Append-only audit log: newest first, filter by object type and action, details as "field: from → to". */
export function AuditView() {
  const { dict } = useI18n();
  const copy = dict.audit;
  const { params, replace, hrefWith } = useUrlParams();

  const entity = parseChoice(params.get('entity_type'), AUDIT_ENTITY_TYPES);
  const action = parseChoice(params.get('action'), AUDIT_ACTIONS);
  const entityIdRaw = params.get('entity_id');
  const entityId = entityIdRaw !== null && /^[\w.-]{1,64}$/.test(entityIdRaw) ? entityIdRaw : null;
  const page = parsePageParam(params.get('page'));

  const query = new URLSearchParams({ page: String(page), page_size: String(AUDIT_PAGE_SIZE) });
  if (entity !== null) query.set('entity_type', entity);
  if (action !== null) query.set('action', action);
  if (entityId !== null) query.set('entity_id', entityId);

  const resource = useApiResource<AuditPage>(`/admin/audit?${query.toString()}`);
  const actionOptions = AUDIT_ACTIONS.filter(
    (item) => entity === null || item.startsWith(`${entity}.`),
  );
  const actionLabels: Record<string, string | undefined> = copy.actions;

  const columns: Array<Column<AuditEntry>> = [
    {
      id: 'when',
      header: copy.columns.when,
      primary: true,
      nowrap: true,
      cell: (entry) => <time dateTime={entry.created_at}>{formatDateTime(entry.created_at)}</time>,
    },
    {
      id: 'actor',
      header: copy.columns.actor,
      cell: (entry) => (
        <>
          {dict.roles[entry.actor_role]}
          {entry.actor_user_id === null ? (
            <span className="block text-sm text-muted-foreground">{copy.system}</span>
          ) : null}
        </>
      ),
    },
    {
      id: 'action',
      header: copy.columns.action,
      cell: (entry) =>
        actionLabels[entry.action] ?? <span className="font-mono">{entry.action}</span>,
    },
    {
      id: 'entity',
      header: copy.columns.entity,
      cell: (entry) => {
        const labels: Record<string, string | undefined> = copy.entities;
        return (
          <>
            {labels[entry.entity_type] ?? entry.entity_type}
            <Link
              href={hrefWith({ entity_type: entry.entity_type, entity_id: entry.entity_id })}
              replace
              className="block font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
              title={entry.entity_id}
            >
              {entry.entity_id.length > 13 ? `${entry.entity_id.slice(0, 8)}…` : entry.entity_id}
            </Link>
          </>
        );
      },
    },
    { id: 'details', header: copy.columns.details, cell: (entry) => <Details entry={entry} /> },
  ];

  const filtered = entity !== null || action !== null || entityId !== null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={copy.title} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {copy.entityFilter}
          <select
            value={entity ?? ''}
            data-testid="audit-entity-filter"
            onChange={(event) => replace({ entity_type: event.target.value, action: null })}
            className={INPUT}
          >
            <option value="">{copy.allEntities}</option>
            {AUDIT_ENTITY_TYPES.map((item: AuditEntityType) => (
              <option key={item} value={item}>
                {copy.entities[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {copy.actionFilter}
          <select
            value={action ?? ''}
            data-testid="audit-action-filter"
            onChange={(event) => replace({ action: event.target.value })}
            className={INPUT}
          >
            <option value="">{copy.allActions}</option>
            {actionOptions.map((item: AuditAction) => (
              <option key={item} value={item}>
                {copy.actions[item]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entityId === null ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-mono break-all">
            {formatMessage(copy.entityIdFilter, { id: entityId })}
          </span>
          <Link
            href={hrefWith({ entity_id: null })}
            replace
            className="font-medium underline underline-offset-2"
          >
            {copy.clearEntityId}
          </Link>
        </p>
      )}

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
                rowKey={(entry) => entry.id}
                rowTestId="audit-row"
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
    </div>
  );
}
