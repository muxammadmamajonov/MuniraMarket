import type { Locale } from './locale';
import type { UserRole } from './enums';

/** All public HTTP routes of the Core API are mounted under this prefix. */
export const API_V1_PREFIX = '/api/v1';

/**
 * Public representation of a user.
 *
 * `telegram_user_id` is a Telegram-assigned identifier that the server has verified. Clients may
 * display it but must never send it back as proof of identity.
 */
export interface UserPublic {
  id: string;
  telegram_user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language: Locale;
  role: UserRole;
}

/** `GET /api/v1/health` (liveness). */
export interface HealthResponse {
  status: 'ok';
  service: 'core-api';
  version: string;
}

/** `GET /api/v1/health/ready`; HTTP 503 with `unavailable` when the database is unreachable. */
export interface ReadinessResponse {
  status: 'ok' | 'unavailable';
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface TelegramInitDataAuthRequest {
  /** Raw `Telegram.WebApp.initData` string. Verified server-side; never parsed client-side. */
  init_data: string;
}

export interface TelegramInitDataAuthResponse {
  user: UserPublic;
}
