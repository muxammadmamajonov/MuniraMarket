import type { Dictionary } from '@/i18n';
import { formatMessage } from '@/i18n/format';
import type { ApiRequestError } from './errors';

/** Localized text for a failed read (never the server's message, which is for logs). */
export function readErrorMessage(dict: Dictionary, error: ApiRequestError): string {
  if (error.code === 'forbidden') return dict.errors.forbidden;
  if (error.code === 'rate_limited') return dict.errors.rateLimited;
  if (error.isNetworkError || error.status >= 500) return dict.errors.serviceUnavailable;
  return dict.errors.message;
}

/** Localized text for a failed `GET /auth/session`. */
export function sessionErrorMessage(dict: Dictionary, error: ApiRequestError | null): string {
  if (error?.code === 'account_blocked') return dict.auth.accountBlocked;
  if (error?.code === 'rate_limited') return dict.auth.rateLimited;
  if (error !== null && (error.isNetworkError || error.status >= 500)) {
    return dict.auth.serviceUnavailable;
  }
  return dict.auth.sessionFailed;
}

/**
 * Localized text for a failed write (save, delete, role change, ...). Known business-rule codes
 * (`sku_taken`, `last_admin`, ...) get their own sentence; field-level 422s are shown next to the
 * fields instead (see `field-errors.ts`) and only fall back to this text.
 */
export function writeErrorMessage(dict: Dictionary, error: ApiRequestError): string {
  if (error.code === 'forbidden') return dict.errors.forbidden;
  if (error.code === 'rate_limited') {
    return error.retryAfter === null
      ? dict.errors.rateLimited
      : formatMessage(dict.apiErrors.rateLimitedWait, { seconds: Math.ceil(error.retryAfter) });
  }
  if (error.isNetworkError || error.status >= 500) return dict.errors.serviceUnavailable;
  const codes: Record<string, string | undefined> = dict.apiErrors.codes;
  return codes[error.code] ?? dict.apiErrors.writeFailed;
}
