import type { Dictionary } from '@/i18n';
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
