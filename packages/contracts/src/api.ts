import type { OrderStatus } from './enums';
import type { components } from './generated/openapi';

/**
 * Public API types. Everything here is an alias of a schema generated from the Core API's OpenAPI
 * document (`openapi.json`, written by `make -C services/api openapi`); regenerate with
 * `pnpm contracts:generate`. Do not hand-write response shapes: change the API and regenerate.
 */
type Schemas = components['schemas'];

/** All public HTTP routes of the Core API are mounted under this prefix. */
export const API_V1_PREFIX = '/api/v1';

// -- Identity & session -----------------------------------------------------------------------

/**
 * Public representation of a user.
 *
 * `telegram_user_id` is a Telegram-assigned identifier that the server has verified. Clients may
 * display it but must never send it back as proof of identity.
 */
export type UserPublic = Schemas['UserPublic'];
export type SetLanguageRequest = Schemas['SetLanguageRequest'];

// -- Profile (session required; writes also CSRF) ---------------------------------------------

/**
 * `PATCH /api/v1/me` body: only the keys sent change; at least one key (an empty object is 422).
 * `first_name` (1-64) cannot be null; `last_name` (0-64, blank -> null), `birth_date`
 * (`YYYY-MM-DD`, 1900-01-01..today in Asia/Tashkent) and `phone` are cleared with `null`. `phone`
 * accepts `+998XXXXXXXXX`, `998XXXXXXXXX` or the 9 national digits (spaces, `-`, `(`, `)`
 * ignored); a number different from the stored one is saved UNVERIFIED (`phone_verified: false`,
 * only the bot's shared contact verifies), the same number keeps its verification. Editing the
 * name stops Telegram sign-ins from overwriting it. Response: `{user: UserPublic}`.
 */
export type UpdateProfileRequest = Schemas['UpdateProfileRequest'];

/** One saved delivery address (`/api/v1/me/addresses`). */
export type SavedAddress = Schemas['SavedAddress'];

/**
 * `POST /api/v1/me/addresses` and `PUT /api/v1/me/addresses/{id}` (full replacement) body: the
 * `DeliveryAddress` fields and rules, plus `label` (0-32, blank -> null) and `is_default`
 * (`true` makes it the default; `false` on the default leaves none; omitted keeps it; the first
 * address is always the default). At most 10 addresses (`409 address_limit_reached`); another
 * user's or a missing id is `404 address_not_found`. `DELETE` is 204 and promotes the most
 * recently updated remaining address when the default is deleted.
 */
export type SavedAddressRequest = Schemas['SavedAddressRequest'];

/** `GET /api/v1/me/addresses`: the default first, then the most recently updated. */
export type SavedAddressList = Schemas['SavedAddressList'];

/**
 * Login response and `GET /auth/session`. `csrf_token` is kept in memory by the client and sent as
 * `X-CSRF-Token` on every unsafe request.
 */
export type SessionResponse = Schemas['SessionResponse'];

/** `POST /auth/telegram/init-data` body: the raw `Telegram.WebApp.initData`, verified server-side. */
export type TelegramInitDataAuthRequest = Schemas['InitDataRequest'];

/** `POST /auth/telegram/init-data` response. */
export type TelegramInitDataAuthResponse = SessionResponse;

/** `GET /api/v1/auth/config`: which browser sign-in methods this entrance offers. */
export type AuthConfig = Schemas['AuthConfigResponse'];

/** `AuthConfig.telegram_oidc`: whether "Sign in with Telegram" (OIDC) is available. */
export type TelegramOidcConfig = Schemas['OidcConfig'];

/**
 * `POST /auth/telegram/oidc/start` body. `return_to` is a same-origin, locale-prefixed path
 * (e.g. `/uz/orders`) the API redirects back to after a successful sign-in.
 */
export type TelegramOidcStartRequest = Schemas['OidcStartRequest'];

/**
 * `POST /auth/telegram/oidc/start` response. The browser must navigate to `authorization_url`
 * top-level (`window.location.assign`), never in a popup or with `fetch`.
 */
export type TelegramOidcStartResponse = Schemas['OidcStartResponse'];

/**
 * Values of `?status=` on `/<locale>/auth/telegram`, where the API's OIDC callback sends the
 * browser when sign-in did not complete.
 */
export const TELEGRAM_OIDC_FAILURE_STATUSES = [
  'failed',
  'cancelled',
  'blocked',
  'unavailable',
] as const;

export type TelegramOidcFailureStatus = (typeof TELEGRAM_OIDC_FAILURE_STATUSES)[number];

/** Narrows a `?status=` value; anything unknown (or missing) is `null`. */
export function parseTelegramOidcFailureStatus(
  value: string | null | undefined,
): TelegramOidcFailureStatus | null {
  return (TELEGRAM_OIDC_FAILURE_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as TelegramOidcFailureStatus)
    : null;
}

// -- Errors -----------------------------------------------------------------------------------

/**
 * Every machine-readable error code the public API can return. Clients switch on `code`; the
 * message is for humans and may change.
 */
export type ApiErrorCode = Schemas['ApiErrorBody']['code'];

/** One validation error (`validation_error`): location and message only, never submitted values. */
export type ApiErrorDetail = Schemas['ErrorDetail'];

/** The `error` object inside every non-2xx JSON response. */
export type ApiErrorBody = Schemas['ApiErrorBody'];

/** Shape of every non-2xx JSON response: `{"error": {...}}`. */
export type ApiErrorEnvelope = Schemas['ErrorEnvelope'];

// -- Catalog (public) -------------------------------------------------------------------------

export type CategoryNode = Schemas['CategoryNode'];

/** `GET /api/v1/categories`. */
export type CategoryList = Schemas['CategoryTree'];

export type ProductSort = Schemas['ProductSort'];

export type ProductSummary = Schemas['ProductSummary'];

export type ProductCategoryRef = Schemas['CategoryRef'];

export type ProductDetail = Schemas['ProductDetail'];

/** `GET /api/v1/products`. */
export type ProductPage = Schemas['ProductPage'];

// -- Cart (session required; writes also CSRF) -----------------------------------------------

export type CartLine = Schemas['CartLine'];

/** Why a cart line is not purchasable as it stands (`null` on the line when it is). */
export type CartLineIssue = NonNullable<CartLine['issue']>;

/**
 * Lines with an `issue` stay visible but are excluded from `item_count`, `subtotal_uzs` and
 * `total_uzs`. All money is computed by the server; clients never sum prices.
 */
export type Cart = Schemas['Cart'];

export type AddCartItemRequest = Schemas['AddCartItemRequest'];

export type UpdateCartItemRequest = Schemas['SetCartItemQuantityRequest'];

// -- Checkout & orders (session required; writes also CSRF) -----------------------------------

/**
 * `POST /api/v1/checkout/quote` (no request body). Server-computed quote; `total_uzs` equals
 * `subtotal_uzs` because delivery is by a Yandex Go courier whom the customer pays directly.
 * Problems are reported in `issues` / `can_place_order` rather than as errors; send `total_uzs`
 * back as `expected_total_uzs` when placing the order.
 */
export type CheckoutQuote = Schemas['CheckoutQuote'];

export type CheckoutQuoteIssue = CheckoutQuote['issues'][number];

/**
 * Where the courier takes the order: the map point (`lat` -90..90, `lon` -180..180, WGS84; the
 * server rounds to 6 decimals) plus street and house. Unknown keys are refused (422).
 */
export type DeliveryAddress = Schemas['DeliveryAddress'];

/** `POST /api/v1/orders` body; needs an `Idempotency-Key` header (16-128 of `[A-Za-z0-9_-]`). */
export type CreateOrderRequest = Schemas['CreateOrderRequest'];

export type OrderLine = Schemas['OrderLine'];

/** Stored address; `lat`/`lon` are `null` only for orders placed before courier delivery. */
export type OrderAddress = Schemas['OrderAddress'];

export type OrderStatusChange = Schemas['OrderStatusChange'];

/**
 * The customer's view of one of their orders. `total_uzs` equals `subtotal_uzs` for new orders;
 * older orders keep the total charged then (including that delivery charge).
 */
export type OrderDetail = Schemas['OrderDetail'];

/** One of an order's first (up to 4) lines; `image_url` is the product's CURRENT image or null. */
export type OrderThumbnail = Schemas['OrderThumbnail'];

export type OrderSummary = Schemas['OrderSummary'];

/** `GET /api/v1/orders?status_group=` (default `all`); `total`/`total_pages` count the group. */
export type OrderStatusGroup = Schemas['OrderStatusGroup'];

/** `GET /api/v1/orders` and `GET /api/v1/admin/orders`. */
export type OrderPage = Schemas['OrderPage'];

/** `POST /api/v1/orders/{id}/cancel` body. */
export type CancelOrderRequest = Schemas['CancelOrderRequest'];

// -- Back office (operator / admin role; writes also CSRF) -------------------------------------

export type AdminStatusChange = Schemas['AdminStatusChange'];

export type AdminOrderDetail = Schemas['AdminOrderDetail'];

/** `PATCH /api/v1/admin/orders/{id}/status` body. */
export type OrderStatusUpdateRequest = Schemas['OrderStatusUpdateRequest'];

/** `GET /api/v1/admin/dashboard` (operator and admin): today's numbers, computed server-side. */
export type Dashboard = Schemas['Dashboard'];

// Admin only from here on.

export type AdminCategory = Schemas['AdminCategory'];
export type AdminCategoryList = Schemas['AdminCategoryList'];
export type CategoryCreateRequest = Schemas['CategoryCreateRequest'];
export type CategoryUpdateRequest = Schemas['CategoryUpdateRequest'];

export type AdminProduct = Schemas['AdminProduct'];
export type AdminProductPage = Schemas['AdminProductPage'];
export type ProductCreateRequest = Schemas['ProductCreateRequest'];
export type ProductUpdateRequest = Schemas['ProductUpdateRequest'];
export type ProductStatusFilter = Schemas['ProductStatusFilter'];

/** `POST /api/v1/admin/catalog/csv/import?dry_run=` response; nothing is written when `errors`. */
export type CsvImportResult = Schemas['CsvImportResult'];
export type CsvRowError = Schemas['CsvRowErrorOut'];

export type AdminUser = Schemas['AdminUser'];
export type AdminUserPage = Schemas['AdminUserPage'];
export type UserUpdateRequest = Schemas['UserUpdateRequest'];

export type AuditEntry = Schemas['AuditEntry'];
export type AuditPage = Schemas['AuditPage'];

/** Header that marks a replayed `POST /orders` (same `Idempotency-Key`, same body). */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

// -- Health -----------------------------------------------------------------------------------

/** `GET /api/v1/health` (liveness). */
export type HealthResponse = Schemas['HealthResponse'];

/** `GET /api/v1/health/ready`; HTTP 503 with `unavailable` when the database is unreachable. */
export type ReadinessResponse = Schemas['ReadinessResponse'];

// -- Runtime lists (checked against the generated types) --------------------------------------

/**
 * Runtime list of {@link ApiErrorCode}. The `satisfies` clause rejects unknown codes and the
 * exhaustiveness check below rejects missing ones, so this cannot drift from the generated type;
 * a test additionally compares it with `openapi.json`.
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
  // profile: saved addresses
  'address_not_found',
  'address_limit_reached',
  // Back office (phase 4).
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
] as const satisfies readonly ApiErrorCode[];

/** Compile error here means the API added an error code that `API_ERROR_CODES` does not list. */
export type MissingApiErrorCodes = Exclude<ApiErrorCode, (typeof API_ERROR_CODES)[number]>;
const assertAllApiErrorCodesListed: [MissingApiErrorCodes] extends [never] ? true : never = true;
void assertAllApiErrorCodesListed;

export const PRODUCT_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'name',
] as const satisfies readonly ProductSort[];

/** Compile error here means the API added a sort key that `PRODUCT_SORTS` does not list. */
export type MissingProductSorts = Exclude<ProductSort, (typeof PRODUCT_SORTS)[number]>;
const assertAllProductSortsListed: [MissingProductSorts] extends [never] ? true : never = true;
void assertAllProductSortsListed;

export const ORDER_STATUS_GROUPS = [
  'all',
  'active',
  'delivering',
  'done',
  'cancelled',
] as const satisfies readonly OrderStatusGroup[];

/** Compile error here means the API added a status group that `ORDER_STATUS_GROUPS` lacks. */
export type MissingOrderStatusGroups = Exclude<
  OrderStatusGroup,
  (typeof ORDER_STATUS_GROUPS)[number]
>;
const assertAllOrderStatusGroupsListed: [MissingOrderStatusGroups] extends [never] ? true : never =
  true;
void assertAllOrderStatusGroupsListed;

/** The order statuses each `status_group` lists (as the API filters them). */
export const ORDER_STATUS_GROUP_STATUSES = {
  all: [
    'NEW',
    'CONFIRMED',
    'PICKING',
    'READY_FOR_DELIVERY',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED',
  ],
  active: ['NEW', 'CONFIRMED', 'PICKING', 'READY_FOR_DELIVERY'],
  delivering: ['OUT_FOR_DELIVERY'],
  done: ['DELIVERED'],
  cancelled: ['CANCELLED'],
} as const satisfies Record<OrderStatusGroup, readonly OrderStatus[]>;
