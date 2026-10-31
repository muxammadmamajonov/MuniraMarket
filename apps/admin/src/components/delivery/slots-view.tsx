'use client';

import type {
  DeliverySlotAdmin,
  DeliverySlotAdminList,
  DeliveryZoneAdmin,
  DeliveryZoneAdminList,
} from '@muniramarket/contracts';
import { Button, EmptyState } from '@muniramarket/ui';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import type { FieldKey } from '@/i18n/dictionaries/sections/shared';
import { writeErrorMessage } from '@/lib/api/error-messages';
import { FORM_LEVEL, fieldErrorsFrom } from '@/lib/api/field-errors';
import { jsonInit, request } from '@/lib/api/request';
import { localName } from '@/lib/catalog';
import { formatCount, formatDate, formatDateTime, formatTime } from '@/lib/format';
import { isUuid } from '@/lib/list-params';
import { parseIntegerField } from '@/lib/numbers';
import {
  addDays,
  cutoffToIso,
  defaultCutoff,
  isHHMM,
  isIsoDate,
  isoToCutoff,
  todayInTashkent,
} from '@/lib/time';
import { useSession } from '@/lib/session';
import { useApiResource } from '@/lib/use-api-resource';
import { useSingleFlight } from '@/lib/use-single-flight';
import { useUrlParams } from '@/lib/use-url-params';
import { Alert } from '../ui/alert';
import { CARD, CHIP, CHIP_OFF, CHIP_ON, INPUT } from '../ui/classes';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { CheckboxField, SelectField, TextField, integerInputAttrs } from '../ui/fields';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ResourceView } from '../ui/resource-view';

type Errors = Partial<Record<FieldKey, string>>;

interface SlotForm {
  zone_id: string;
  slot_date: string;
  starts_at: string;
  ends_at: string;
  capacity: string;
  /** `null` = follow the default (two hours before the start). */
  cutoff: string | null;
  is_active: boolean;
}

function SlotDialog({
  slot,
  zones,
  initialZone,
  initialDate,
  opener,
  onClose,
  onSaved,
}: {
  slot: DeliverySlotAdmin | null;
  zones: readonly DeliveryZoneAdmin[];
  initialZone: string;
  initialDate: string;
  opener: HTMLElement | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { dict, locale } = useI18n();
  const copy = dict.slots.form;
  const { apiFetch } = useSession();
  const { pending, run } = useSingleFlight();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<SlotForm>(
    slot === null
      ? {
          zone_id: initialZone,
          slot_date: initialDate,
          starts_at: '14:00',
          ends_at: '16:00',
          capacity: '10',
          cutoff: null,
          is_active: true,
        }
      : {
          zone_id: slot.zone_id,
          slot_date: slot.slot_date,
          starts_at: formatTime(slot.starts_at),
          ends_at: formatTime(slot.ends_at),
          capacity: String(slot.capacity),
          cutoff: isoToCutoff(slot.cutoff_at),
          is_active: slot.is_active,
        },
  );
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const cutoff = form.cutoff ?? defaultCutoff(form.slot_date, form.starts_at);
  const locked = slot !== null;

  const set = <K extends keyof SlotForm>(key: K, value: SlotForm[K], field?: FieldKey) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (field !== undefined) setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const validate = (): Errors => {
    const found: Errors = {};
    const required = dict.validation.required;
    const rule = (key: FieldKey) => dict.validation.fields[key];
    if (form.zone_id === '') found.zone_id = rule('zone_id');
    if (!isIsoDate(form.slot_date))
      found.slot_date = form.slot_date === '' ? required : rule('slot_date');
    if (!isHHMM(form.starts_at))
      found.starts_at = form.starts_at === '' ? required : rule('starts_at');
    if (!isHHMM(form.ends_at)) found.ends_at = form.ends_at === '' ? required : rule('ends_at');
    else if (isHHMM(form.starts_at) && form.ends_at <= form.starts_at)
      found.ends_at = rule('ends_at');
    const capacity = parseIntegerField(form.capacity, { min: 0, max: 10000 });
    if (capacity === null) found.capacity = required;
    else if (capacity === 'invalid') found.capacity = rule('capacity');
    if (cutoff === '' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cutoff)) {
      found.cutoff_at = cutoff === '' ? required : rule('cutoff_at');
    } else if (
      isIsoDate(form.slot_date) &&
      isHHMM(form.starts_at) &&
      cutoff > `${form.slot_date}T${form.starts_at}`
    ) {
      found.cutoff_at = rule('cutoff_at');
    }
    return found;
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      queueMicrotask(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const capacity = parseIntegerField(form.capacity, { min: 0, max: 10000 }) as number;

    void run(async () => {
      let result;
      if (slot === null) {
        result = await request<DeliverySlotAdmin>(
          apiFetch,
          '/admin/delivery/slots',
          jsonInit('POST', {
            zone_id: form.zone_id,
            slot_date: form.slot_date,
            starts_at: form.starts_at,
            ends_at: form.ends_at,
            capacity,
            cutoff_at: cutoffToIso(cutoff),
            is_active: form.is_active,
          }),
        );
      } else {
        const changes: Record<string, unknown> = {};
        if (capacity !== slot.capacity) changes['capacity'] = capacity;
        if (cutoff !== isoToCutoff(slot.cutoff_at)) changes['cutoff_at'] = cutoffToIso(cutoff);
        if (form.is_active !== slot.is_active) changes['is_active'] = form.is_active;
        if (Object.keys(changes).length === 0) {
          setFormError(copy.noChanges);
          return;
        }
        result = await request<DeliverySlotAdmin>(
          apiFetch,
          `/admin/delivery/slots/${encodeURIComponent(slot.id)}`,
          jsonInit('PATCH', changes),
        );
      }
      if (result.ok) {
        onSaved(slot === null ? dict.slots.created : dict.slots.saved);
        return;
      }
      const { error } = result;
      if (error.code === 'capacity_below_reserved') {
        setErrors({ capacity: dict.apiErrors.codes.capacity_below_reserved });
      } else if (error.code === 'validation_error') {
        const fields = fieldErrorsFrom(error);
        const next: Errors = {};
        for (const name of Object.keys(fields)) {
          if (name !== FORM_LEVEL && name in dict.validation.fields) {
            next[name as FieldKey] = dict.validation.fields[name as FieldKey];
          }
        }
        setErrors(next);
        setFormError(dict.validation.summary);
      } else {
        setFormError(writeErrorMessage(dict, locale, error));
      }
    });
  };

  const zoneOptions = zones.map((zone) => ({ value: zone.id, label: localName(zone, locale) }));

  return (
    <Modal
      title={slot === null ? copy.titleNew : copy.titleEdit}
      onClose={onClose}
      dismissible={!pending}
      returnFocusTo={opener}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        {formError === null ? null : <Alert tone="error">{formError}</Alert>}
        {locked ? <Alert tone="info">{copy.lockedHint}</Alert> : null}
        <SelectField
          label={copy.zone}
          value={form.zone_id}
          onChange={(value) => set('zone_id', value, 'zone_id')}
          options={zoneOptions}
          placeholder={copy.zonePlaceholder}
          disabled={locked}
          error={errors.zone_id ?? null}
          testId="slot-zone"
        />
        <TextField
          label={copy.date}
          error={errors.slot_date ?? null}
          testId="slot-date"
          input={{
            type: 'date',
            value: form.slot_date,
            disabled: locked,
            onChange: (event) => set('slot_date', event.target.value, 'slot_date'),
          }}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={copy.startsAt}
            error={errors.starts_at ?? null}
            testId="slot-starts-at"
            input={{
              type: 'time',
              step: 60,
              value: form.starts_at,
              disabled: locked,
              onChange: (event) => set('starts_at', event.target.value, 'starts_at'),
            }}
          />
          <TextField
            label={copy.endsAt}
            error={errors.ends_at ?? null}
            testId="slot-ends-at"
            input={{
              type: 'time',
              step: 60,
              value: form.ends_at,
              disabled: locked,
              onChange: (event) => set('ends_at', event.target.value, 'ends_at'),
            }}
          />
        </div>
        <TextField
          label={copy.capacity}
          hint={copy.capacityHint}
          error={errors.capacity ?? null}
          testId="slot-capacity"
          input={integerInputAttrs(form.capacity, (value) => set('capacity', value, 'capacity'))}
        />
        <TextField
          label={copy.cutoff}
          hint={copy.cutoffHint}
          error={errors.cutoff_at ?? null}
          testId="slot-cutoff"
          input={{
            type: 'datetime-local',
            value: cutoff,
            onChange: (event) => set('cutoff', event.target.value, 'cutoff_at'),
          }}
        />
        <CheckboxField
          label={copy.isActive}
          checked={form.is_active}
          onChange={(checked) => set('is_active', checked)}
          testId="slot-active"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {dict.common.cancel}
          </Button>
          <Button type="submit" disabled={pending} data-testid="slot-create">
            {pending ? dict.common.saving : slot === null ? copy.submitNew : copy.submitEdit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CapacityBar({ slot }: { slot: DeliverySlotAdmin }) {
  const { dict } = useI18n();
  const copy = dict.slots;
  const share =
    slot.capacity === 0 ? 0 : Math.min(100, (slot.reserved_count / slot.capacity) * 100);
  const full = slot.remaining <= 0;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={`h-full rounded-full ${full ? 'bg-red-700 dark:bg-red-500' : 'bg-primary'}`}
          style={{ width: `${share}%` }}
        />
      </div>
      <p className="text-sm text-muted-foreground tabular">
        {formatMessage(copy.reserved, {
          reserved: formatCount(slot.reserved_count),
          capacity: formatCount(slot.capacity),
        })}{' '}
        · {full ? copy.full : formatMessage(copy.remaining, { count: formatCount(slot.remaining) })}
      </p>
    </div>
  );
}

type DialogState =
  | { kind: 'form'; slot: DeliverySlotAdmin | null; opener: HTMLElement | null }
  | { kind: 'delete'; slot: DeliverySlotAdmin; opener: HTMLElement | null };

/** Delivery slots, grouped by date, with capacity bars; filter by zone and date range. */
export function SlotsView() {
  const { dict, locale } = useI18n();
  const copy = dict.slots;
  const { apiFetch } = useSession();
  const { params, replace } = useUrlParams();
  const today = todayInTashkent();

  const zoneParam = params.get('zone');
  const zoneId = isUuid(zoneParam) ? zoneParam : '';
  const fromParam = params.get('from');
  const toParam = params.get('to');
  const dateFrom = fromParam !== null && isIsoDate(fromParam) ? fromParam : today;
  const dateTo = toParam !== null && isIsoDate(toParam) ? toParam : addDays(dateFrom, 13);

  const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  if (zoneId !== '') query.set('zone_id', zoneId);

  const slots = useApiResource<DeliverySlotAdminList>(`/admin/delivery/slots?${query.toString()}`);
  const zones = useApiResource<DeliveryZoneAdminList>('/admin/delivery/zones');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const toggling = useSingleFlight();

  const zoneNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const zone of zones.data?.items ?? []) map.set(zone.id, localName(zone, locale));
    return map;
  }, [zones.data, locale]);

  const toggle = (slot: DeliverySlotAdmin) =>
    toggling.run(async () => {
      setRowError(null);
      setNotice(null);
      const result = await request<DeliverySlotAdmin>(
        apiFetch,
        `/admin/delivery/slots/${encodeURIComponent(slot.id)}`,
        jsonInit('PATCH', { is_active: !slot.is_active }),
      );
      if (result.ok) slots.reload();
      else setRowError(writeErrorMessage(dict, locale, result.error));
    });

  const remove = async (slot: DeliverySlotAdmin): Promise<string | null> => {
    const result = await request(
      apiFetch,
      `/admin/delivery/slots/${encodeURIComponent(slot.id)}`,
      jsonInit('DELETE'),
    );
    if (!result.ok) return writeErrorMessage(dict, locale, result.error);
    setNotice(copy.deleted);
    slots.reload();
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={copy.title}
        actions={
          <Button
            onClick={(event) =>
              setDialog({ kind: 'form', slot: null, opener: event.currentTarget })
            }
            disabled={zones.status !== 'ready' || (zones.data?.items.length ?? 0) === 0}
            data-testid="new-slot"
          >
            {copy.newSlot}
          </Button>
        }
      />
      {zones.status === 'ready' && zones.data?.items.length === 0 ? (
        <Alert tone="info">{copy.noZones}</Alert>
      ) : null}
      {notice === null ? null : <Alert tone="success">{notice}</Alert>}
      {rowError === null ? null : <Alert tone="error">{rowError}</Alert>}

      <form
        aria-label={copy.filtersLabel}
        onSubmit={(event) => event.preventDefault()}
        className="grid gap-3 sm:grid-cols-3"
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {copy.zone}
          <select
            value={zoneId}
            onChange={(event) => replace({ zone: event.target.value })}
            data-testid="slots-zone-filter"
            className={INPUT}
          >
            <option value="">{copy.allZones}</option>
            {[...zoneNames].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {copy.from}
          <input
            type="date"
            value={dateFrom}
            data-testid="slots-from"
            onChange={(event) =>
              isIsoDate(event.target.value) && replace({ from: event.target.value })
            }
            className={INPUT}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {copy.to}
          <input
            type="date"
            value={dateTo}
            min={dateFrom}
            data-testid="slots-to"
            onChange={(event) =>
              isIsoDate(event.target.value) && replace({ to: event.target.value })
            }
            className={INPUT}
          />
        </label>
      </form>

      <ResourceView resource={slots} loadingLabel={copy.loading}>
        {(data) => {
          if (data.items.length === 0) {
            return <EmptyState title={zoneId !== '' ? copy.emptyFiltered : copy.empty} />;
          }
          const days = new Map<string, DeliverySlotAdmin[]>();
          for (const slot of [...data.items].sort(
            (a, b) =>
              a.slot_date.localeCompare(b.slot_date) || a.starts_at.localeCompare(b.starts_at),
          )) {
            days.set(slot.slot_date, [...(days.get(slot.slot_date) ?? []), slot]);
          }
          return (
            <div className="flex flex-col gap-5">
              {data.truncated ? <Alert tone="warning">{copy.truncated}</Alert> : null}
              <div aria-label={copy.dayList} className="flex flex-col gap-5">
                {[...days].map(([date, items]) => (
                  <section
                    key={date}
                    aria-label={formatMessage(copy.slotsOfDay, { date: formatDate(date) })}
                    className="flex flex-col gap-2"
                  >
                    <h2 className="text-lg font-semibold tabular">{formatDate(date)}</h2>
                    <ul className="flex flex-col gap-2">
                      {items.map((slot) => {
                        const time = `${formatTime(slot.starts_at)}–${formatTime(slot.ends_at)}`;
                        return (
                          <li
                            key={slot.id}
                            data-testid="slot-row"
                            className={`${CARD} lg:flex-row lg:items-center lg:justify-between`}
                          >
                            <div className="min-w-0 lg:w-56">
                              <p className="text-lg font-semibold tabular">{time}</p>
                              <p className="text-sm text-muted-foreground break-words">
                                {zoneNames.get(slot.zone_id) ?? dict.common.noValue}
                              </p>
                              <p className="text-sm text-muted-foreground tabular">
                                {formatMessage(copy.cutoff, {
                                  time: formatDateTime(slot.cutoff_at),
                                })}
                              </p>
                            </div>
                            <div className="min-w-0 flex-1 lg:max-w-xs">
                              <CapacityBar slot={slot} />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                aria-pressed={slot.is_active}
                                aria-label={formatMessage(copy.toggleLabel, { time })}
                                disabled={toggling.pending}
                                onClick={() => void toggle(slot)}
                                className={`${CHIP} ${slot.is_active ? CHIP_ON : CHIP_OFF} disabled:opacity-50`}
                              >
                                {slot.is_active ? dict.common.active : dict.common.inactive}
                              </button>
                              <Button
                                variant="secondary"
                                onClick={(event) =>
                                  setDialog({ kind: 'form', slot, opener: event.currentTarget })
                                }
                                aria-label={`${copy.edit}: ${formatDate(date)} ${time}`}
                              >
                                {copy.edit}
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={(event) =>
                                  setDialog({ kind: 'delete', slot, opener: event.currentTarget })
                                }
                                aria-label={`${copy.remove}: ${formatDate(date)} ${time}`}
                              >
                                {copy.remove}
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          );
        }}
      </ResourceView>

      {dialog?.kind === 'form' ? (
        <SlotDialog
          slot={dialog.slot}
          zones={zones.data?.items ?? []}
          initialZone={zoneId}
          initialDate={dateFrom}
          opener={dialog.opener}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setDialog(null);
            setNotice(message);
            slots.reload();
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={copy.delete.title}
          description={formatMessage(copy.delete.description, {
            date: formatDate(dialog.slot.slot_date),
            time: `${formatTime(dialog.slot.starts_at)}–${formatTime(dialog.slot.ends_at)}`,
          })}
          confirmLabel={copy.delete.confirm}
          onConfirm={() => remove(dialog.slot)}
          onClose={() => setDialog(null)}
          returnFocusTo={dialog.opener}
        />
      ) : null}
    </div>
  );
}
