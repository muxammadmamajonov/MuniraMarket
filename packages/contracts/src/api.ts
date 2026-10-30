import type { Locale } from './locale';
import type { ProductUnit, UserRole } from './enums';

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

/**
 * Every machine-readable error code the public API can return. Clients switch on `code`; the
 * message is for humans and may change.
 *
 * Mirrors `ErrorCode` in `services/api/app/core/errors.py`. Hand-written for now; a later step
 * replaces these with aliases of the OpenAPI-generated types.
 */
export const API_ERROR_CODES = [
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
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorDetail {
  loc: string[];
  msg: string;
}

/** The `error` object inside every non-2xx JSON response. */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  /** Validation errors (`validation_error`): location and message only, never submitted values. */
  details?: ApiErrorDetail[] | null;
  /** Only set for `insufficient_stock`: how many units can currently be ordered. */
  available_quantity?: number | null;
}

/** Shape of every non-2xx JSON response: `{"error": {...}}`. */
export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

export interface TelegramInitDataAuthRequest {
  /** Raw `Telegram.WebApp.initData` string. Verified server-side; never parsed client-side. */
  init_data: string;
}

/**
 * Login response and `GET /auth/session`. `csrf_token` is kept in memory by the client and sent as
 * `X-CSRF-Token` on every unsafe request.
 */
export interface SessionResponse {
  user: UserPublic;
  csrf_token: string;
}

/** `POST /auth/telegram/init-data` response. */
export type TelegramInitDataAuthResponse = SessionResponse;

/** `GET /api/v1/auth/config`. */
export interface AuthConfig {
  telegram_login_widget: {
    enabled: boolean;
    bot_username: string | null;
  };
}

/** `POST /auth/telegram/login-widget` body: the fields Telegram's Login Widget passes to onauth. */
export interface TelegramLoginWidgetPayload {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// ---------------------------------------------------------------------------------------------
// Catalog (public)
// ---------------------------------------------------------------------------------------------

export interface CategoryNode {
  id: string;
  slug: string;
  name_uz: string;
  name_ru: string;
  image_url: string | null;
  sort_order: number;
  children: CategoryNode[];
}

/** `GET /api/v1/categories`. */
export interface CategoryList {
  items: CategoryNode[];
}

export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'name'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export interface ProductSummary {
  id: string;
  slug: string;
  sku: string;
  name_uz: string;
  name_ru: string;
  unit: ProductUnit;
  /** Integer UZS. */
  price_uzs: number;
  /** Integer UZS; present when the product is discounted. */
  old_price_uzs: number | null;
  /** `null` means stock is not tracked (no limit). */
  stock_quantity: number | null;
  in_stock: boolean;
  image_url: string | null;
  category_id: string;
}

export interface ProductCategoryRef {
  id: string;
  slug: string;
  name_uz: string;
  name_ru: string;
}

export interface ProductDetail extends ProductSummary {
  description_uz: string | null;
  description_ru: string | null;
  brand: string | null;
  category: ProductCategoryRef;
}

/** `GET /api/v1/products`. */
export interface ProductPage {
  items: ProductSummary[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

// ---------------------------------------------------------------------------------------------
// Cart (session required; writes also CSRF)
// ---------------------------------------------------------------------------------------------

export type CartLineIssue = 'product_inactive' | 'insufficient_stock';

export interface CartLine {
  product: ProductSummary;
  quantity: number;
  /** Integer UZS, computed by the server. */
  line_total_uzs: number;
  issue: CartLineIssue | null;
}

/**
 * Lines with an `issue` stay visible but are excluded from `item_count`, `subtotal_uzs` and
 * `total_uzs`. All money is computed by the server; clients never sum prices.
 */
export interface Cart {
  items: CartLine[];
  /** Sum of quantities of valid lines. */
  item_count: number;
  subtotal_uzs: number;
  total_uzs: number;
  has_issues: boolean;
}

export interface AddCartItemRequest {
  product_id: string;
  /** 1..99 */
  quantity: number;
}

export interface UpdateCartItemRequest {
  /** 1..99 */
  quantity: number;
}
