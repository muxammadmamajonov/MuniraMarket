'use client';

import { PAYMENT_METHODS, type PaymentMethod } from '@muniramarket/contracts';
import { useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import { formatAddressLine, type Address } from '@/lib/address/address';
import {
  LIMITS,
  charCount,
  type CheckoutFormValues,
  type FieldError,
  type FieldName,
  type FormErrors,
} from '@/lib/checkout/form';
import { AddressPicker } from '../address-picker';
import { FormField } from '../form-field';
import { PinIcon } from '../icons';
import { CARD, ERROR_TEXT, FOCUS_RING, INPUT, PRESS } from '../ui-classes';
import { STEP_HEADING, StepNumber } from './step-number';
import { RadioCard } from '../ui/radio-card';

export interface CheckoutFormProps {
  values: CheckoutFormValues;
  errors: FormErrors;
  disabled: boolean;
  onChange: <K extends FieldName>(field: K, value: CheckoutFormValues[K]) => void;
  /** An address saved in the map picker. */
  onAddress: (address: Address) => void;
  onBlur: (field: FieldName) => void;
}

/** Delivery address, recipient, payment method and comment. All text is the customer's own. */
export function CheckoutFormFields({
  values,
  errors,
  disabled,
  onChange,
  onAddress,
  onBlur,
}: CheckoutFormProps) {
  const { dict } = useI18n();
  const t = dict.checkout;
  const [pickerOpen, setPickerOpen] = useState(false);

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
    field: 'recipientName' | 'recipientPhone',
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

  const commentLength = charCount(values.comment);
  const address = values.address;
  const addressLine = address === null ? null : formatAddressLine(address, dict.address);
  const addressError = errorText('address');

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section aria-labelledby="checkout-delivery" className={`${CARD} flex flex-col gap-3`}>
        <h2 id="checkout-delivery" className={STEP_HEADING}>
          <StepNumber step={1} />
          {t.sections.delivery}
        </h2>

        {address === null || addressLine === null ? null : (
          <div data-testid="checkout-address" className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink"
            >
              <PinIcon width={18} height={18} />
            </span>
            <div className="flex min-w-0 flex-col">
              <p className="font-semibold [overflow-wrap:anywhere]">{addressLine}</p>
              {address.landmark.trim() === '' ? null : (
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {address.landmark}
                </p>
              )}
            </div>
          </div>
        )}

        <button
          type="button"
          name="address"
          data-field="address"
          aria-haspopup="dialog"
          aria-describedby={addressError === undefined ? undefined : 'checkout-address-error'}
          disabled={disabled}
          onClick={() => setPickerOpen(true)}
          className={
            address === null
              ? `inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-5 font-semibold text-primary-foreground enabled:hover:bg-primary-hover disabled:opacity-50 ${PRESS} ${FOCUS_RING}`
              : `inline-flex min-h-11 items-center justify-center self-start rounded-xl bg-surface-muted px-4 text-sm font-semibold enabled:hover:bg-border disabled:opacity-50 ${PRESS} ${FOCUS_RING}`
          }
        >
          {address === null ? (
            <>
              <PinIcon width={20} height={20} aria-hidden="true" />
              {t.chooseAddress}
            </>
          ) : (
            t.changeAddress
          )}
        </button>
        {addressError === undefined ? null : (
          <p id="checkout-address-error" role="alert" className={ERROR_TEXT}>
            {addressError}
          </p>
        )}

        <AddressPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          initial={address}
          onSave={(next) => {
            setPickerOpen(false);
            onAddress(next);
          }}
        />
      </section>

      <section aria-labelledby="checkout-recipient" className={`${CARD} flex flex-col gap-4`}>
        <h2 id="checkout-recipient" className={STEP_HEADING}>
          <StepNumber step={2} />
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
        <legend className={`${STEP_HEADING} float-left w-full`}>
          <StepNumber step={3} />
          {t.sections.payment}
        </legend>
        <div role="radiogroup" className="flex flex-col gap-2">
          {PAYMENT_METHODS.map((method: PaymentMethod) => (
            <RadioCard
              key={method}
              name="paymentMethod"
              value={method}
              checked={values.paymentMethod === method}
              onChange={() => onChange('paymentMethod', method)}
              onBlur={() => onBlur('paymentMethod')}
            >
              {dict.orders.payment[method]}
            </RadioCard>
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
        <h2 id="checkout-comment" className={STEP_HEADING}>
          <StepNumber step={4} />
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
