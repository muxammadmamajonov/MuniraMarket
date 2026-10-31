import {
  API_V1_PREFIX,
  isApiErrorEnvelope,
  type ApiErrorCode,
  type ApiErrorDetail,
  type OrderStatus,
} from '@muniramarket/contracts';

/**
 * Seconds to wait from a `Retry-After` header: a number of seconds, or an HTTP date (what some
 * proxies send). `null` when it is missing, malformed or already in the past.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds : null;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  const delta = (date - now) / 1000;
  return delta > 0 ? delta : null;
}

/** Client-side error codes for failures that never produced an API envelope. */
export type LocalErrorCode = 'network_error' | 'invalid_response' | 'unknown_error';

/**
 * A failed API call. `code` is the server's machine-readable code when an error envelope was
 * received, otherwise a local code. Messages are for logs, not for display: the UI maps `code`
 * to localized copy.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | LocalErrorCode;
  /** Only for `insufficient_stock`. */
  readonly availableQuantity: number | null;
  /** `insufficient_stock` / `product_inactive`: the product that blocked the order. */
  readonly productId: string | null;
  /** `price_changed`: the order total the server would charge now. */
  readonly totalUzs: number | null;
  /** `order_not_cancellable` and friends: the order's status at the time of the call. */
  readonly currentStatus: OrderStatus | null;
  /** `validation_error`: one entry per invalid field (location and message only). */
  readonly details: readonly ApiErrorDetail[];
  /** Seconds from `Retry-After`, if present. */
  readonly retryAfter: number | null;

  constructor(init: {
    status: number;
    code: ApiErrorCode | LocalErrorCode;
    message: string;
    availableQuantity?: number | null | undefined;
    productId?: string | null | undefined;
    totalUzs?: number | null | undefined;
    currentStatus?: OrderStatus | null | undefined;
    details?: readonly ApiErrorDetail[] | null | undefined;
    retryAfter?: number | null | undefined;
  }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.status = init.status;
    this.code = init.code;
    this.availableQuantity = init.availableQuantity ?? null;
    this.productId = init.productId ?? null;
    this.totalUzs = init.totalUzs ?? null;
    this.currentStatus = init.currentStatus ?? null;
    this.details = init.details ?? [];
    this.retryAfter = init.retryAfter ?? null;
  }

  /** True when the request never got an HTTP response (offline, DNS, refused, aborted). */
  get isNetworkError(): boolean {
    return this.code === 'network_error';
  }

  static network(cause?: unknown): ApiRequestError {
    return new ApiRequestError({
      status: 0,
      code: 'network_error',
      message: cause instanceof Error ? cause.message : 'Network request failed',
    });
  }

  /** Builds an error from a non-2xx response, reading the envelope if there is one. */
  static async fromResponse(response: Response): Promise<ApiRequestError> {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Not JSON (for example an HTML error page from a proxy in front of us).
    }
    if (isApiErrorEnvelope(body)) {
      return new ApiRequestError({
        status: response.status,
        code: body.error.code,
        message: body.error.message,
        availableQuantity: body.error.available_quantity,
        productId: body.error.product_id,
        totalUzs: body.error.total_uzs,
        currentStatus: body.error.current_status,
        details: body.error.details,
        retryAfter,
      });
    }
    return new ApiRequestError({
      status: response.status,
      code: 'unknown_error',
      message: `Request failed with status ${String(response.status)}`,
      retryAfter,
    });
  }
}

/** Reads a JSON body, mapping parse failures to {@link ApiRequestError}. */
export async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiRequestError({
      status: response.status,
      code: 'invalid_response',
      message: 'Response was not valid JSON',
    });
  }
}

/** Same-origin path of a v1 API route, e.g. `apiPath('/cart')` -> `/api/v1/cart`. */
export function apiPath(path: string): string {
  return `${API_V1_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}
