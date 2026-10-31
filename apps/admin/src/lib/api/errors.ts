import {
  API_V1_PREFIX,
  isApiErrorEnvelope,
  type ApiErrorCode,
  type ApiErrorDetail,
} from '@muniramarket/contracts';
import type { OrderStatus } from '@muniramarket/contracts';

/** Client-side error codes for failures that never produced an API envelope. */
export type LocalErrorCode = 'network_error' | 'invalid_response' | 'unknown_error';

/**
 * A failed API call. `code` is the server's machine-readable code when an error envelope was
 * received, otherwise a local code. Messages are for logs, not for display: the UI maps `code`
 * to localized copy. Neither the message nor anything else here ever carries order or recipient
 * data.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | LocalErrorCode;
  /** The order's real status, on `order_status_conflict` / `invalid_status_transition`. */
  readonly currentStatus: OrderStatus | null;
  /** Seconds from `Retry-After`, if present. */
  readonly retryAfter: number | null;
  /** Field-level problems of a 422 (`loc` + `msg`, never submitted values). Empty otherwise. */
  readonly details: readonly ApiErrorDetail[];
  /** The district code on `district_taken`. */
  readonly district: string | null;

  constructor(init: {
    status: number;
    code: ApiErrorCode | LocalErrorCode;
    message: string;
    currentStatus?: OrderStatus | null | undefined;
    retryAfter?: number | null | undefined;
    details?: readonly ApiErrorDetail[] | null | undefined;
    district?: string | null | undefined;
  }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.status = init.status;
    this.code = init.code;
    this.currentStatus = init.currentStatus ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.details = init.details ?? [];
    this.district = init.district ?? null;
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
    const retryHeader = Number(response.headers.get('retry-after'));
    const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null;
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
        currentStatus: body.error.current_status,
        retryAfter,
        details: Array.isArray(body.error.details) ? body.error.details : null,
        district: typeof body.error.district === 'string' ? body.error.district : null,
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

/** Same-origin path of a v1 API route, e.g. `apiPath('/auth/session')` -> `/api/v1/auth/session`. */
export function apiPath(path: string): string {
  return `${API_V1_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}
