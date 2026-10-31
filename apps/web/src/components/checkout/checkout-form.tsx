'use client';

import {
  PAYMENT_METHODS,
  type DeliveryZone,
  type DistrictCode,
  type PaymentMethod,
} from '@muniramarket/contracts';
import { formatUZS } from '@muniramarket/ui';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import {
  LIMITS,
  charCount,
  type CheckoutFormValues,
  type FieldError,
  type FieldName,
  type FormErrors,
} from '@/lib/checkout/form';
import { districtGroups, districtName, zoneHours, zoneName } from '@/lib/checkout/zones';
import { FormField } from '../form-field';
import { CARD, ERROR_TEXT, INPUT } from '../ui-classes';

export interface CheckoutFormProps {
  values: CheckoutFormValues;
  errors: FormErrors;
  zones: DeliveryZone[];
  /** The zone of the selected district, for the hint under the select. */
  selectedZone: DeliveryZone | null;
  disabled: boolean;
  onChange: <K extends FieldName>(field: K, value: CheckoutFormValues[K]) => void;
  onDistrict: (district: DistrictCode | '') => void;
  onBlur: (field: FieldName) => void;
  /** The delivery-time picker; rendered under the address, where the district is chosen. */
  slotPicker?: ReactNode;
}

/** Delivery address, recipient, payment method and comment. All text is the customer's own. */
export function CheckoutFormFields({
  values,
  errors,
  zones,
  selectedZone,
  disabled,
  onChange,
  onDistrict,
  onBlur,
  slotPicker = null,
}: CheckoutFormProps) {
  const { dict, locale } = useI18n();
  const t = dict.checkout;

  const errorText = (field: FieldName): string | undefined => {
    const error: FieldError | undefined = errors[field];
    if (error === undefined) return undefined;
    switch (error.kind) {
      case 'required':
        return t.errors.required;
      case 'tooShort':
        return formatMessage(t.errors.tooShort, { min: error.limit ?? 0 });
      case 'tooLong':
        return formatMessage(t.errors.tooLong, { max: error.limit ?? 0 });
      case 'phone':
        return t.errors.phone;
      case 'singleLine':
        return t.errors.singleLine;
      case 'invalid':
        return t.errors.invalid;
    }
  };

  const text = (
    field: Exclude<FieldName, 'district' | 'paymentMethod' | 'comment'>,
    config: {
      label: string;
      optional?: boolean;
      required?: boolean;
      autoComplete: string;
      className?: string;
      type?: 'text' | 'tel';
      inputMode?: 'text' | 'tel';
      autoCapitalize?: 'words' | 'sentences' | 'none';
      limit: number;
    },
  ) => (
    <FormField
      label={config.label}
      {...(config.optional === true ? { optionalLabel: t.optional } : {})}
      error={errorText(field)}
      required={config.required ?? false}
      {...(config.className === undefined ? {} : { className: config.className })}
    >
      {(control) => (
        <input
          {...control}
          name={field}
          type={config.type ?? 'text'}
          inputMode={config.inputMode ?? 'text'}
          autoComplete={config.autoComplete}
          autoCapitalize={config.autoCapitalize ?? 'sentences'}
          enterKeyHint="next"
          maxLength={config.limit}
          disabled={disabled}
          value={values[field]}
          onChange={(event) => onChange(field, event.target.value)}
          onBlur={() => onBlur(field)}
          data-user-text=""
          className={INPUT}
        />
      )}
    </FormField>
  );

  const groups = districtGroups(zones);
  const commentLength = charCount(values.comment);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-labelledby="checkout-delivery" className={`${CARD} flex flex-col gap-4`}>
        <h2 id="checkout-delivery" className="text-lg font-bold">
          {t.sections.delivery}
        </h2>

        <FormField
          label={t.labels.district}
          error={errorText('district')}
          required
          hint={
            selectedZone === null ? undefined : (
              <span className="flex flex-col gap-0.5">
                <span>{formatMessage(t.zoneHours, { time: zoneHours(selectedZone) })}</span>
                <span>
                  {formatMessage(t.zoneMinOrder, {
                    min: formatUZS(selectedZone.min_order_uzs, locale),
                  })}
                </span>
                {selectedZone.free_delivery_threshold_uzs === null ? null : (
                  <span>
                    {formatMessage(t.zoneFreeFrom, {
                      threshold: formatUZS(selectedZone.free_delivery_threshold_uzs, locale),
                    })}
                  </span>
                )}
              </span>
            )
          }
        >
          {(control) => (
            <select
              {...control}
              name="district"
              autoComplete="off"
              disabled={disabled}
              value={values.district}
              onChange={(event) => onDistrict(event.target.value as DistrictCode | '')}
              onBlur={() => onBlur('district')}
              className={INPUT}
            >
              <option value="" disabled>
                {t.districtPlaceholder}
              </option>
              {groups.map(({ zone, districts }) => (
                <optgroup
                  key={zone.id}
                  label={formatMessage(t.zoneGroup, {
                    zone: zoneName(zone, locale),
                    fee:
                      zone.delivery_fee_uzs === 0
                        ? t.summary.free
                        : formatUZS(zone.delivery_fee_uzs, locale),
                  })}
                >
                  {districts.map((district) => (
                    <option key={district.code} value={district.code}>
                      {districtName(district, locale)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </FormField>

        {text('street', {
          label: t.labels.street,
          required: true,
          autoComplete: 'address-line1',
          limit: LIMITS.street.max,
        })}
        <div className="grid grid-cols-2 gap-3">
          {text('house', {
            label: t.labels.house,
            required: true,
            autoComplete: 'off',
            limit: LIMITS.house.max,
          })}
          {text('apartment', {
            label: t.labels.apartment,
            optional: true,
            autoComplete: 'off',
            limit: LIMITS.apartment.max,
          })}
          {text('entrance', {
            label: t.labels.entrance,
            optional: true,
            autoComplete: 'off',
            limit: LIMITS.entrance.max,
          })}
          {text('floor', {
            label: t.labels.floor,
            optional: true,
            autoComplete: 'off',
            limit: LIMITS.floor.max,
          })}
        </div>
        {text('landmark', {
          label: t.labels.landmark,
          optional: true,
          autoComplete: 'off',
          limit: LIMITS.landmark.max,
        })}
      </section>

      {slotPicker}

      <section aria-labelledby="checkout-recipient" className={`${CARD} flex flex-col gap-4`}>
        <h2 id="checkout-recipient" className="text-lg font-bold">
          {t.sections.recipient}
        </h2>
        {text('recipientName', {
          label: t.labels.recipientName,
          required: true,
          autoComplete: 'name',
          autoCapitalize: 'words',
          limit: LIMITS.recipientName.max,
        })}
        {text('recipientPhone', {
          label: t.labels.recipientPhone,
          required: true,
          autoComplete: 'tel',
          type: 'tel',
          inputMode: 'tel',
          autoCapitalize: 'none',
          limit: 32,
        })}
      </section>

      <fieldset
        disabled={disabled}
        aria-describedby={
          errors.paymentMethod === undefined
            ? 'checkout-payment-hint'
            : 'checkout-payment-hint checkout-payment-error'
        }
        className={`${CARD} flex min-w-0 flex-col gap-3`}
      >
        <legend className="px-1 text-lg font-bold">{t.sections.payment}</legend>
        <div role="radiogroup" className="flex flex-col gap-2">
          {PAYMENT_METHODS.map((method: PaymentMethod) => (
            <label
              key={method}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 py-2 transition-colors duration-150 has-checked:border-primary has-checked:bg-surface-muted has-focus-visible:outline-2 has-focus-visible:outline-focus"
            >
              <input
                type="radio"
                name="paymentMethod"
                value={method}
                checked={values.paymentMethod === method}
                onChange={() => onChange('paymentMethod', method)}
                onBlur={() => onBlur('paymentMethod')}
                className="size-5 shrink-0 accent-primary"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {dict.orders.payment[method]}
              </span>
            </label>
          ))}
        </div>
        <p id="checkout-payment-hint" className="text-sm text-muted-foreground">
          {t.paymentHint}
        </p>
        {errors.paymentMethod === undefined ? null : (
          <p id="checkout-payment-error" role="alert" className={ERROR_TEXT}>
            {errorText('paymentMethod')}
          </p>
        )}
      </fieldset>

      <section aria-labelledby="checkout-comment" className={`${CARD} flex flex-col gap-4`}>
        <h2 id="checkout-comment" className="text-lg font-bold">
          {t.sections.comment}
        </h2>
        <FormField
          label={t.labels.comment}
          optionalLabel={t.optional}
          error={errorText('comment')}
          aside={
            <span data-money className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">
              {formatMessage(t.charCounter, { count: commentLength, max: LIMITS.comment.max })}
            </span>
          }
        >
          {(control) => (
            <textarea
              {...control}
              name="comment"
              rows={3}
              autoComplete="off"
              autoCapitalize="sentences"
              maxLength={LIMITS.comment.max}
              placeholder={t.commentPlaceholder}
              disabled={disabled}
              value={values.comment}
              onChange={(event) => onChange('comment', event.target.value)}
              onBlur={() => onBlur('comment')}
              data-user-text=""
              className={`${INPUT} resize-y`}
            />
          )}
        </FormField>
      </section>
    </div>
  );
}
