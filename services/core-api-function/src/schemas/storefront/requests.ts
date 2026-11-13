/**
 * Request models (ports of services/api/app/schemas/{cart,checkout}.py and the catalog / order
 * query parameters). Free-text fields are trimmed, blank optional fields become `null` and
 * control characters are rejected, exactly like the Pydantic models.
 */
import { createHash } from 'node:crypto';
import { MAX_LINE_QUANTITY } from '../../domain/cart.ts';
import { PHONE_MESSAGE, normalizeUzPhone } from '../../domain/checkout.ts';
import { ORDER_STATUSES, ORDER_STATUS_GROUPS } from '../../domain/orderStatus.ts';
import {
  checkBirthDate,
  normalizeProfilePhone,
  parseBirthDate,
  tashkentToday,
} from '../../domain/profile.ts';
import { PRODUCT_SORTS } from '../../repositories/catalog.ts';
import { PAYMENT_METHODS } from '../../repositories/orders.ts';
import {
  INVALID,
  ValueError,
  blankToNull,
  bool,
  float,
  int,
  model,
  nullable,
  oneOf,
  str,
  uuid,
  type Invalid,
  type Validator,
} from './fields.ts';

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = new RegExp('[\\x00-\\x08\\x0b-\\x1f\\x7f]');
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_OR_NEWLINE = new RegExp('[\\x00-\\x1f\\x7f]');

function singleLine(value: string): string {
  if (CONTROL_OR_NEWLINE.test(value)) throw new ValueError('must be a single line of text');
  return value;
}

function multiLine(value: string): string {
  if (CONTROL.test(value)) throw new ValueError('contains control characters');
  return value;
}

function phone(value: string): string {
  try {
    return normalizeUzPhone(value);
  } catch {
    throw new ValueError(PHONE_MESSAGE);
  }
}

const text = (min: number, max: number, after: (value: string) => string) =>
  str({ strip: true, min, max, after });
const optionalText = (max: number, after: (value: string) => string) =>
  blankToNull(nullable(text(0, max, after)));

const street = text(2, 200, singleLine);
const house = text(1, 32, singleLine);
const recipientName = text(2, 100, singleLine);
const shortPart = optionalText(16, singleLine);
const floor = optionalText(8, singleLine);
const landmark = optionalText(200, singleLine);
const comment = optionalText(500, multiLine);
const reason = text(3, 300, multiLine);
const quantity = int({ ge: 1, le: MAX_LINE_QUANTITY });

export const COORDINATE_DECIMALS = 6;

/** Python's `round(value, 6)` for a coordinate (the sign of zero kept). */
export function roundCoordinate(value: number): number {
  return Object.is(value, -0) ? -0 : Number(value.toFixed(COORDINATE_DECIMALS));
}

const latitude = float({ ge: -90, le: 90, after: roundCoordinate });
const longitude = float({ ge: -180, le: 180, after: roundCoordinate });

export type Output<V> = V extends Validator<infer T> ? Exclude<T, Invalid> : never;

// --- cart ----------------------------------------------------------------------------------------

export const addCartItemRequest = model({ product_id: uuid(), quantity });
export const setCartItemQuantityRequest = model({ quantity });

// --- checkout / orders ---------------------------------------------------------------------------

/**
 * Where the Yandex Go courier delivers: the map point (WGS84, rounded to 6 decimals, about 0.1 m)
 * and the address details the courier needs at the door.
 */
const deliveryAddressShape = {
  lat: latitude,
  lon: longitude,
  street,
  house,
  apartment: shortPart,
  entrance: shortPart,
  floor,
  landmark,
};
export const deliveryAddress = model(deliveryAddressShape);

export const createOrderRequest = model({
  address: deliveryAddress,
  recipient_name: recipientName,
  recipient_phone: str({ max: 32, after: phone }),
  payment_method: oneOf(PAYMENT_METHODS),
  comment,
  // The `total_uzs` of the quote the customer confirmed.
  expected_total_uzs: int({ ge: 0 }),
});
export type CreateOrderRequest = Output<typeof createOrderRequest>;

export const cancelOrderRequest = model({ reason });

export const orderStatusUpdateRequest = model({
  status: oneOf(ORDER_STATUSES),
  // Required (non-blank) when cancelling.
  reason: nullable(reason),
  // Optimistic concurrency: refuse with 409 if the order is no longer in this status.
  expected_status: nullable(oneOf(ORDER_STATUSES)),
});

// --- profile (`PATCH /me`) and saved addresses -----------------------------------------------------

/** An optional key: absent -> `undefined` ("not sent"), anything else -> `inner`. */
export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, loc, issues) => (value === undefined ? undefined : inner(value, loc, issues));
}

/**
 * An optional, NOT nullable key (`X | None = None` refusing an explicit null in the reference):
 * absent -> `undefined`, `null` -> `message`, anything else -> `inner`.
 */
export function optionalNotNull<T>(inner: Validator<T>, message: string): Validator<T | undefined> {
  return (value, loc, issues) => {
    if (value === undefined) return undefined;
    if (value === null) {
      issues.push({ loc: loc.map(String), msg: message });
      return INVALID;
    }
    return inner(value, loc, issues);
  };
}

function profilePhone(value: string): string {
  try {
    return normalizeProfilePhone(value);
  } catch (error) {
    if (error instanceof RangeError) throw new ValueError(error.message);
    throw error;
  }
}

/** `YYYY-MM-DD`, 1900-01-01..today (Asia/Tashkent); messages as the reference's validators. */
const birthDate: Validator<string> = (value, loc, issues) => {
  if (value === undefined) {
    issues.push({ loc: loc.map(String), msg: 'Field required' });
    return INVALID;
  }
  try {
    return checkBirthDate(parseBirthDate(value), tashkentToday());
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    issues.push({ loc: loc.map(String), msg: `Value error, ${error.message}` });
    return INVALID;
  }
};

export const AT_LEAST_ONE_FIELD = 'Value error, at least one field is required';

/** `PATCH /me` body; the route also refuses an empty object (`AT_LEAST_ONE_FIELD`). */
export const updateProfileRequest = model({
  first_name: optionalNotNull(text(1, 64, singleLine), 'Input should be a valid string'),
  last_name: optional(optionalText(64, singleLine)),
  birth_date: optional(nullable(birthDate)),
  phone: optional(nullable(str({ max: 32, after: profilePhone }))),
});
export type UpdateProfileRequest = Output<typeof updateProfileRequest>;

/** `POST /me/addresses` and `PUT /me/addresses/{id}`: a `DeliveryAddress` plus label/default. */
export const savedAddressRequest = model({
  ...deliveryAddressShape,
  label: optionalText(32, singleLine),
  is_default: optionalNotNull(bool(), 'Input should be a valid boolean'),
});
export type SavedAddressRequest = Output<typeof savedAddressRequest>;

/** A float as Pydantic's `model_dump_json()` writes it (`69.0`, `1e-6`, `0.00001`). */
export function pydanticFloat(value: number): string {
  if (Number.isInteger(value)) return Object.is(value, -0) ? '-0.0' : `${value}.0`;
  const magnitude = Math.abs(value);
  // JS switches to exponent notation below 1e-6, Pydantic below 1e-5.
  if (magnitude >= 1e-6 && magnitude < 1e-5) return value.toExponential();
  return String(value);
}

/**
 * Fingerprint of the *validated* request (Pydantic's `model_dump_json()`: compact JSON, fields in
 * declaration order, non-ASCII kept as UTF-8, floats always with a fraction or exponent), so
 * cosmetic differences (spacing in the phone number, surrounding whitespace, coordinate digits
 * beyond the sixth decimal) do not make a retry look like a different order. Byte-identical to
 * the reference, so keys used against the FastAPI service replay here too.
 */
export function requestHash(payload: CreateOrderRequest): string {
  const { address, ...rest } = payload;
  const { lat, lon, ...details } = address;
  const addressJson =
    `{"lat":${pydanticFloat(lat)},"lon":${pydanticFloat(lon)},` + JSON.stringify(details).slice(1);
  const body = `{"address":${addressJson},` + JSON.stringify(rest).slice(1);
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// --- query parameters ----------------------------------------------------------------------------

export const CATALOG_MAX_PAGE_SIZE = 48;
export const CATALOG_DEFAULT_PAGE_SIZE = 24;
/** Far beyond any real catalog; only keeps (page - 1) * page_size inside a database bigint. */
export const CATALOG_MAX_PAGE = 1_000_000;

export const productQuery = {
  category: nullable(str({ min: 1, max: 128 })),
  // Trimmed before validation, so "  a " is too short and "  milk  " searches for "milk".
  q: nullable(str({ strip: true, min: 2, max: 100 })),
  in_stock: withDefault(bool(), false),
  sort: withDefault(oneOf(PRODUCT_SORTS), 'newest'),
  page: withDefault(int({ ge: 1, le: CATALOG_MAX_PAGE }), 1),
  page_size: withDefault(int({ ge: 1, le: CATALOG_MAX_PAGE_SIZE }), CATALOG_DEFAULT_PAGE_SIZE),
};

export const ORDERS_MAX_PAGE_SIZE = 50;
export const ORDERS_DEFAULT_PAGE_SIZE = 20;
export const ORDERS_MAX_PAGE = 100_000;

export const orderPageQuery = {
  page: withDefault(int({ ge: 1, le: ORDERS_MAX_PAGE }), 1),
  page_size: withDefault(int({ ge: 1, le: ORDERS_MAX_PAGE_SIZE }), ORDERS_DEFAULT_PAGE_SIZE),
  status_group: withDefault(oneOf(ORDER_STATUS_GROUPS), 'all'),
};

/** A query parameter with a default (absent -> `fallback`; `null` cannot occur in a query). */
export function withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
  return (value, loc, issues) => (value === undefined ? fallback : inner(value, loc, issues));
}

/** `^[A-Za-z0-9_-]{16,128}$` (FastAPI `Header(pattern=...)`). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const idempotencyKeyHeader: Validator<string> = (value, loc, issues) => {
  if (value === undefined) {
    issues.push({ loc: loc.map(String), msg: 'Field required' });
    return INVALID;
  }
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    issues.push({
      loc: loc.map(String),
      msg: `String should match pattern '${IDEMPOTENCY_KEY_PATTERN.source}'`,
    });
    return INVALID;
  }
  return value;
};
