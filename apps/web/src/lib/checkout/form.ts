import type {
  ApiErrorDetail,
  CreateOrderRequest,
  DistrictCode,
  PaymentMethod,
} from '@muniramarket/contracts';

/**
 * Checkout form state, validation and request building. Limits mirror the Core API
 * (`app/schemas/checkout.py`); the server stays the authority and its 422 answers are mapped back
 * onto fields by {@link serverFieldErrors}.
 */

export interface CheckoutFormValues {
  district: DistrictCode | '';
  street: string;
  house: string;
  apartment: string;
  entrance: string;
  floor: string;
  landmark: string;
  recipientName: string;
  recipientPhone: string;
  paymentMethod: PaymentMethod | '';
  comment: string;
}

export type FieldName = keyof CheckoutFormValues;

/** Why a field is invalid. Mapped to localized copy by the UI. */
export type FieldErrorKind =
  'required' | 'tooShort' | 'tooLong' | 'phone' | 'singleLine' | 'invalid';

export interface FieldError {
  kind: FieldErrorKind;
  /** For `tooShort` / `tooLong`. */
  limit?: number;
}

export type FormErrors = Partial<Record<FieldName, FieldError>>;

/** Fields in page order, used to focus the first invalid one. */
export const FIELD_ORDER: readonly FieldName[] = [
  'district',
  'street',
  'house',
  'apartment',
  'entrance',
  'floor',
  'landmark',
  'recipientName',
  'recipientPhone',
  'paymentMethod',
  'comment',
];

interface Limit {
  min: number;
  max: number;
}

export const LIMITS = {
  street: { min: 2, max: 200 },
  house: { min: 1, max: 32 },
  apartment: { min: 0, max: 16 },
  entrance: { min: 0, max: 16 },
  floor: { min: 0, max: 8 },
  landmark: { min: 0, max: 200 },
  recipientName: { min: 2, max: 100 },
  comment: { min: 0, max: 500 },
} as const satisfies Record<string, Limit>;

export const PHONE_PREFIX = '+998 ';

export function emptyFormValues(): CheckoutFormValues {
  return {
    district: '',
    street: '',
    house: '',
    apartment: '',
    entrance: '',
    floor: '',
    landmark: '',
    recipientName: '',
    recipientPhone: PHONE_PREFIX,
    paymentMethod: '',
    comment: '',
  };
}

/** Length in characters as the server counts them (code points, not UTF-16 units). */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** First `max` characters of `text`, never splitting a surrogate pair. */
export function clampChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

function hasControlCharacter(text: string, allowNewlineAndTab: boolean): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (allowNewlineAndTab && (code === 0x09 || code === 0x0a)) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `+998 00 123-45-67` -> `+998001234567`; `null` for anything that is not +998 and 9 digits. */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-()]/g, '');
  return /^\+998\d{9}$/.test(compact) ? compact : null;
}

function checkText(
  raw: string,
  { min, max }: Limit,
  options: { singleLine: boolean },
): FieldError | null {
  const value = raw.trim();
  const length = charCount(value);
  if (length === 0 && min > 0) return { kind: 'required' };
  if (length > 0 && length < min) return { kind: 'tooShort', limit: min };
  if (length > max) return { kind: 'tooLong', limit: max };
  if (hasControlCharacter(value, !options.singleLine)) {
    return { kind: options.singleLine ? 'singleLine' : 'invalid' };
  }
  return null;
}

/** Client-side validation. Returns an empty object when the form can be sent. */
export function validateForm(values: CheckoutFormValues): FormErrors {
  const errors: FormErrors = {};
  const set = (field: FieldName, error: FieldError | null) => {
    if (error !== null) errors[field] = error;
  };

  if (values.district === '') errors.district = { kind: 'required' };
  set('street', checkText(values.street, LIMITS.street, { singleLine: true }));
  set('house', checkText(values.house, LIMITS.house, { singleLine: true }));
  set('apartment', checkText(values.apartment, LIMITS.apartment, { singleLine: true }));
  set('entrance', checkText(values.entrance, LIMITS.entrance, { singleLine: true }));
  set('floor', checkText(values.floor, LIMITS.floor, { singleLine: true }));
  set('landmark', checkText(values.landmark, LIMITS.landmark, { singleLine: true }));
  set('recipientName', checkText(values.recipientName, LIMITS.recipientName, { singleLine: true }));

  const phone = values.recipientPhone.trim();
  if (phone === '' || phone === PHONE_PREFIX.trim()) errors.recipientPhone = { kind: 'required' };
  else if (normalizePhone(phone) === null) errors.recipientPhone = { kind: 'phone' };

  if (values.paymentMethod === '') errors.paymentMethod = { kind: 'required' };
  set('comment', checkText(values.comment, LIMITS.comment, { singleLine: false }));
  return errors;
}

/** The first field (in page order) that has an error, or `null`. */
export function firstInvalidField(errors: FormErrors): FieldName | null {
  return FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null;
}

function optional(raw: string): string | undefined {
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * The `POST /orders` body, or `null` while the form is invalid. Text is trimmed and blank optional
 * fields are left out, as the server would normalize them; the key order is fixed so that the same
 * form always serializes to the same string (the idempotency fingerprint). `deliverySlotId` is part
 * of the body only when a slot was chosen, so choosing another slot yields another fingerprint and
 * therefore another idempotency key.
 */
export function buildOrderRequest(
  values: CheckoutFormValues,
  expectedTotalUzs: number,
  deliverySlotId: string | null = null,
): CreateOrderRequest | null {
  if (Object.keys(validateForm(values)).length > 0) return null;
  const phone = normalizePhone(values.recipientPhone);
  if (values.district === '' || values.paymentMethod === '' || phone === null) return null;

  const apartment = optional(values.apartment);
  const entrance = optional(values.entrance);
  const floor = optional(values.floor);
  const landmark = optional(values.landmark);
  const comment = optional(values.comment);
  return {
    address: {
      district: values.district,
      street: values.street.trim(),
      house: values.house.trim(),
      ...(apartment === undefined ? {} : { apartment }),
      ...(entrance === undefined ? {} : { entrance }),
      ...(floor === undefined ? {} : { floor }),
      ...(landmark === undefined ? {} : { landmark }),
    },
    recipient_name: values.recipientName.trim(),
    recipient_phone: phone,
    payment_method: values.paymentMethod,
    ...(comment === undefined ? {} : { comment }),
    ...(deliverySlotId === null ? {} : { delivery_slot_id: deliverySlotId }),
    expected_total_uzs: expectedTotalUzs,
  };
}

/** Idempotency fingerprint: two requests are "the same order" exactly when this is equal. */
export function requestFingerprint(request: CreateOrderRequest): string {
  return JSON.stringify(request);
}

const SERVER_FIELD_BY_LOC: Readonly<Record<string, FieldName>> = {
  street: 'street',
  house: 'house',
  apartment: 'apartment',
  entrance: 'entrance',
  floor: 'floor',
  landmark: 'landmark',
  district: 'district',
  recipient_name: 'recipientName',
  recipient_phone: 'recipientPhone',
  payment_method: 'paymentMethod',
  comment: 'comment',
};

/**
 * Maps a 422 `details` list (`loc` like `["body", "address", "street"]`) onto form fields. Entries
 * that point at something the form has no field for (for example `expected_total_uzs`) are
 * returned as `unmapped` so the UI can show a general message.
 */
export function serverFieldErrors(details: readonly ApiErrorDetail[]): {
  fields: FormErrors;
  unmapped: number;
} {
  const fields: FormErrors = {};
  let unmapped = 0;
  for (const detail of details) {
    const key = detail.loc[detail.loc.length - 1] ?? '';
    const field = SERVER_FIELD_BY_LOC[key];
    if (field === undefined) unmapped += 1;
    else fields[field] ??= { kind: 'invalid' };
  }
  return { fields, unmapped };
}
