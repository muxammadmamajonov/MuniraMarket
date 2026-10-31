'use client';

import type {
  DeliveryZoneAdmin,
  DeliveryZoneAdminList,
  DistrictCode,
} from '@muniramarket/contracts';
import { Button, EmptyState, formatUZS } from '@muniramarket/ui';
import { useRef, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import type { FieldKey } from '@/i18n/dictionaries/sections/shared';
import { writeErrorMessage } from '@/lib/api/error-messages';
import { FORM_LEVEL, fieldErrorsFrom } from '@/lib/api/field-errors';
import { jsonInit, request } from '@/lib/api/request';
import { localName } from '@/lib/catalog';
import { DISTRICT_CODES, districtName } from '@/lib/districts';
import { toHHMM } from '@/lib/time';
import {
  buildZoneCreate,
  buildZoneUpdate,
  emptyZoneForm,
  validateZone,
  zoneToForm,
  type ZoneFormValues,
} from '@/lib/zones';
import { useSession } from '@/lib/session';
import { useApiResource } from '@/lib/use-api-resource';
import { useSingleFlight } from '@/lib/use-single-flight';
import { Alert } from '../ui/alert';
import { ActivePill } from '../ui/active-pill';
import { ALERT_TEXT, CARD } from '../ui/classes';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { CheckboxField, TextField, integerInputAttrs, textInputAttrs } from '../ui/fields';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ResourceView } from '../ui/resource-view';

type Errors = Partial<Record<FieldKey, string>>;

function ZoneDialog({
  zone,
  zones,
  opener,
  onClose,
  onSaved,
}: {
  zone: DeliveryZoneAdmin | null;
  zones: readonly DeliveryZoneAdmin[];
  opener: HTMLElement | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { dict, locale } = useI18n();
  const copy = dict.zones.form;
  const { apiFetch } = useSession();
  const { pending, run } = useSingleFlight();
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState<ZoneFormValues>(
    zone === null ? emptyZoneForm() : zoneToForm(zone),
  );
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = <K extends keyof ZoneFormValues>(
    key: K,
    value: ZoneFormValues[K],
    field?: FieldKey,
  ) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (field !== undefined) setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  // District code -> the other zone that already has it (those are disabled here).
  const takenBy = new Map<string, DeliveryZoneAdmin>();
  for (const other of zones) {
    if (other.id === zone?.id) continue;
    for (const district of other.districts) takenBy.set(district.code, other);
  }

  const toggleDistrict = (code: DistrictCode, on: boolean) =>
    set(
      'districts',
      on ? [...form.districts, code] : form.districts.filter((item) => item !== code),
      'districts',
    );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const problems = validateZone(form);
    const shown: Errors = {};
    for (const [key, problem] of Object.entries(problems) as Array<[FieldKey, string]>) {
      // A missing choice reads better as the instruction itself than as "required field".
      shown[key] =
        problem === 'required' && key !== 'districts'
          ? dict.validation.required
          : dict.validation.fields[key];
    }
    setErrors(shown);
    if (Object.keys(shown).length > 0) {
      queueMicrotask(() =>
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"],[data-invalid="true"]')
          ?.focus(),
      );
      return;
    }

    void run(async () => {
      if (zone === null) {
        const result = await request<DeliveryZoneAdmin>(
          apiFetch,
          '/admin/delivery/zones',
          jsonInit('POST', buildZoneCreate(form)),
        );
        return finish(result);
      }
      const changes = buildZoneUpdate(form, zone);
      if (Object.keys(changes).length === 0) {
        setFormError(copy.noChanges);
        return;
      }
      const result = await request<DeliveryZoneAdmin>(
        apiFetch,
        `/admin/delivery/zones/${encodeURIComponent(zone.id)}`,
        jsonInit('PATCH', changes),
      );
      return finish(result);
    });
  };

  const finish = (result: Awaited<ReturnType<typeof request<DeliveryZoneAdmin>>>) => {
    if (result.ok) {
      onSaved(zone === null ? dict.zones.created : dict.zones.saved);
      return;
    }
    const { error } = result;
    if (error.code === 'slug_taken') {
      setErrors({ slug: dict.apiErrors.codes.slug_taken });
    } else if (error.code === 'district_taken') {
      // Names the district and keeps the form so the admin can untick it.
      setErrors({ districts: writeErrorMessage(dict, locale, error) });
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
  };

  return (
    <Modal
      title={zone === null ? copy.titleNew : copy.titleEdit}
      onClose={onClose}
      dismissible={!pending}
      returnFocusTo={opener}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        {formError === null ? null : <Alert tone="error">{formError}</Alert>}
        <TextField
          label={copy.nameUz}
          error={errors.name_uz ?? null}
          testId="zone-name-uz"
          input={{
            type: 'text',
            lang: 'uz',
            maxLength: 255,
            value: form.name_uz,
            onChange: (event) => set('name_uz', event.target.value, 'name_uz'),
          }}
        />
        <TextField
          label={copy.nameRu}
          error={errors.name_ru ?? null}
          testId="zone-name-ru"
          input={{
            type: 'text',
            lang: 'ru',
            maxLength: 255,
            value: form.name_ru,
            onChange: (event) => set('name_ru', event.target.value, 'name_ru'),
          }}
        />
        <TextField
          label={copy.slug}
          error={errors.slug ?? null}
          testId="zone-slug"
          input={{
            ...textInputAttrs(form.slug, (value) => set('slug', value, 'slug')),
            autoCapitalize: 'none',
            autoCorrect: 'off',
            spellCheck: false,
            maxLength: 64,
          }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={copy.fee}
            error={errors.delivery_fee_uzs ?? null}
            testId="zone-fee"
            input={integerInputAttrs(form.fee, (v) => set('fee', v, 'delivery_fee_uzs'))}
          />
          <TextField
            label={copy.minOrder}
            error={errors.min_order_uzs ?? null}
            testId="zone-min-order"
            input={integerInputAttrs(form.min_order, (v) => set('min_order', v, 'min_order_uzs'))}
          />
        </div>
        <TextField
          label={copy.freeThreshold}
          optionalLabel={dict.common.optional}
          hint={copy.freeThresholdHint}
          error={errors.free_delivery_threshold_uzs ?? null}
          testId="zone-free-threshold"
          input={integerInputAttrs(form.free_threshold, (v) =>
            set('free_threshold', v, 'free_delivery_threshold_uzs'),
          )}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label={copy.opensAt}
            error={errors.opens_at ?? null}
            testId="zone-opens-at"
            input={{
              type: 'time',
              step: 60,
              value: form.opens_at,
              onChange: (event) => set('opens_at', event.target.value, 'opens_at'),
            }}
          />
          <TextField
            label={copy.closesAt}
            error={errors.closes_at ?? null}
            testId="zone-closes-at"
            input={{
              type: 'time',
              step: 60,
              value: form.closes_at,
              onChange: (event) => set('closes_at', event.target.value, 'closes_at'),
            }}
          />
          <TextField
            label={copy.sortOrder}
            error={errors.sort_order ?? null}
            testId="zone-sort-order"
            input={integerInputAttrs(form.sort_order, (v) => set('sort_order', v, 'sort_order'), {
              allowNegative: true,
            })}
          />
        </div>

        <fieldset className="flex min-w-0 flex-col gap-1" data-testid="zone-districts">
          <legend className="font-medium">{copy.districts}</legend>
          <p className="text-sm text-muted-foreground">{copy.districtsHint}</p>
          <div className="grid gap-x-3 sm:grid-cols-2">
            {DISTRICT_CODES.map((code) => {
              const other = takenBy.get(code);
              return (
                <CheckboxField
                  key={code}
                  label={districtName(code, locale)}
                  {...(other === undefined
                    ? {}
                    : {
                        hint: formatMessage(copy.districtTaken, { zone: localName(other, locale) }),
                      })}
                  checked={form.districts.includes(code)}
                  disabled={other !== undefined}
                  onChange={(checked) => toggleDistrict(code, checked)}
                  testId={`zone-district-${code}`}
                />
              );
            })}
          </div>
          {errors.districts === undefined || errors.districts === '' ? null : (
            <p role="alert" data-invalid="true" tabIndex={-1} className={ALERT_TEXT}>
              {errors.districts}
            </p>
          )}
        </fieldset>

        <CheckboxField
          label={copy.isActive}
          checked={form.is_active}
          onChange={(checked) => set('is_active', checked)}
          testId="zone-active"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {dict.common.cancel}
          </Button>
          <Button type="submit" disabled={pending} data-testid="zone-save">
            {pending ? dict.common.saving : zone === null ? copy.submitNew : copy.submitEdit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type DialogState =
  | { kind: 'form'; zone: DeliveryZoneAdmin | null; opener: HTMLElement | null }
  | { kind: 'delete'; zone: DeliveryZoneAdmin; opener: HTMLElement | null };

/** Delivery zones: fee, free-delivery threshold, minimum order, hours and the districts they cover. */
export function ZonesView() {
  const { dict, locale } = useI18n();
  const copy = dict.zones;
  const { apiFetch } = useSession();
  const resource = useApiResource<DeliveryZoneAdminList>('/admin/delivery/zones');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const remove = async (zone: DeliveryZoneAdmin): Promise<string | null> => {
    const result = await request(
      apiFetch,
      `/admin/delivery/zones/${encodeURIComponent(zone.id)}`,
      jsonInit('DELETE'),
    );
    if (!result.ok) return writeErrorMessage(dict, locale, result.error);
    setNotice(copy.deleted);
    resource.reload();
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={copy.title}
        actions={
          <Button
            onClick={(event) =>
              setDialog({ kind: 'form', zone: null, opener: event.currentTarget })
            }
            data-testid="new-zone"
          >
            {copy.newZone}
          </Button>
        }
      />
      {notice === null ? null : <Alert tone="success">{notice}</Alert>}

      <ResourceView resource={resource} loadingLabel={copy.loading}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={copy.empty} />
          ) : (
            <ul aria-label={copy.list} className="grid gap-3 lg:grid-cols-2">
              {data.items.map((zone) => (
                <li key={zone.id} data-testid="zone-card" className={CARD}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg font-semibold break-words">
                        {localName(zone, locale)}
                      </h2>
                      <p className="font-mono text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                        {zone.slug}
                      </p>
                    </div>
                    <ActivePill active={zone.is_active} />
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">{copy.fee}</dt>
                    <dd>
                      {formatUZS(zone.delivery_fee_uzs, locale)}
                      <span className="block text-sm text-muted-foreground">
                        {zone.free_delivery_threshold_uzs === null
                          ? copy.neverFree
                          : formatMessage(copy.freeFrom, {
                              amount: formatUZS(zone.free_delivery_threshold_uzs, locale),
                            })}
                      </span>
                    </dd>
                    <dt className="text-muted-foreground">{copy.minOrder}</dt>
                    <dd>{formatUZS(zone.min_order_uzs, locale)}</dd>
                    <dt className="text-muted-foreground">{copy.hours}</dt>
                    <dd className="tabular">
                      {toHHMM(zone.opens_at)}–{toHHMM(zone.closes_at)}
                    </dd>
                    <dt className="text-muted-foreground">{copy.districts}</dt>
                    <dd className="min-w-0 break-words">
                      {zone.districts
                        .map((district) => districtName(district.code, locale))
                        .join(', ')}
                    </dd>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onClick={(event) =>
                        setDialog({ kind: 'form', zone, opener: event.currentTarget })
                      }
                      aria-label={`${copy.edit}: ${localName(zone, locale)}`}
                    >
                      {copy.edit}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={(event) =>
                        setDialog({ kind: 'delete', zone, opener: event.currentTarget })
                      }
                      aria-label={`${copy.remove}: ${localName(zone, locale)}`}
                    >
                      {copy.remove}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>

      {dialog?.kind === 'form' ? (
        <ZoneDialog
          zone={dialog.zone}
          zones={resource.data?.items ?? []}
          opener={dialog.opener}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setDialog(null);
            setNotice(message);
            resource.reload();
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={copy.delete.title}
          description={formatMessage(copy.delete.description, {
            name: localName(dialog.zone, locale),
          })}
          confirmLabel={copy.delete.confirm}
          onConfirm={() => remove(dialog.zone)}
          onClose={() => setDialog(null)}
          returnFocusTo={dialog.opener}
        />
      ) : null}
    </div>
  );
}
