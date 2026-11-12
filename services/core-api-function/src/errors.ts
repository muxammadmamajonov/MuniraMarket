/**
 * Uniform error envelope, identical to the FastAPI reference (services/api/app/core/errors.py):
 * `{"error": {"code": ..., "message": ..., ...extra}}`. Clients switch on `code`; the message is
 * for humans. Keep `ERROR_CODES` in sync with the OpenAPI `ApiErrorBody.code` enum (a contract
 * test enforces it).
 */

export const ERROR_CODES = [
  // generic (derived from the HTTP status)
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'validation_error',
  'rate_limited',
  'internal_error',
  'service_unavailable',
  // auth / session
  'invalid_telegram_auth',
  'session_required',
  'csrf_failed',
  'account_blocked',
  'feature_disabled',
  // catalog / cart
  'category_not_found',
  'product_not_found',
  'product_inactive',
  'insufficient_stock',
  'cart_limit_reached',
  'cart_item_not_found',
  // checkout / orders
  'cart_empty',
  'price_changed',
  'idempotency_key_conflict',
  'order_not_found',
  'order_not_cancellable',
  'invalid_status_transition',
  'order_status_conflict',
  'too_many_open_orders',
  'phone_verification_required',
  // admin: catalog, CSV, users
  'slug_taken',
  'sku_taken',
  'category_cycle',
  'category_not_empty',
  'product_archived',
  'csv_invalid_encoding',
  'csv_invalid_header',
  'csv_malformed',
  'csv_too_many_rows',
  'user_not_found',
  'last_admin',
  'cannot_block_self',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_error',
  429: 'rate_limited',
  500: 'internal_error',
  503: 'service_unavailable',
};

export function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? `http_${status}`;
}

export interface ErrorDetail {
  loc: string[];
  msg: string;
}

/** Optional typed fields of the envelope (see `ApiErrorBody` in the OpenAPI document). */
export interface ErrorExtra {
  details?: ErrorDetail[];
  available_quantity?: number;
  product_id?: string;
  total_uzs?: number;
  current_status?: string;
}

/** Throw from routes/services to return a typed error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Readonly<Record<string, string>>;
  readonly extra: ErrorExtra;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { headers?: Record<string, string>; extra?: ErrorExtra } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.headers = options.headers ?? {};
    this.extra = options.extra ?? {};
  }
}

export function errorBody(
  code: string,
  message: string,
  extra: ErrorExtra = {},
): { error: Record<string, unknown> } {
  return { error: { code, message, ...extra } };
}

export function errorJson(
  status: number,
  code: string,
  message: string,
  init: { headers?: Record<string, string>; extra?: ErrorExtra } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(errorBody(code, message, init.extra)), { status, headers });
}

export function apiErrorResponse(error: ApiError): Response {
  return errorJson(error.status, error.code, error.message, {
    headers: { ...error.headers },
    extra: error.extra,
  });
}

/** Thrown by security stores when PostgreSQL is unreachable; routes fail closed with 503. */
export class StoreUnavailableError extends Error {
  constructor() {
    super('security store unavailable');
    this.name = 'StoreUnavailableError';
  }
}

export const storeUnavailable = (): ApiError =>
  new ApiError(503, 'service_unavailable', 'Service temporarily unavailable');
export const sessionRequired = (): ApiError =>
  new ApiError(401, 'session_required', 'Sign-in required');
export const accountBlocked = (): ApiError =>
  new ApiError(403, 'account_blocked', 'Account is blocked');
export const csrfFailed = (): ApiError =>
  new ApiError(403, 'csrf_failed', 'CSRF validation failed');
export const notFound = (message = 'Not Found'): ApiError =>
  new ApiError(404, 'not_found', message);
export const forbidden = (message: string): ApiError => new ApiError(403, 'forbidden', message);
