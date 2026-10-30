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

/**
 * Login response and `GET /auth/session`. `csrf_token` is kept in memory by the client and sent as
 * `X-CSRF-Token` on every unsafe request.
 */
export type SessionResponse = Schemas['SessionResponse'];

/** `POST /auth/telegram/init-data` body: the raw `Telegram.WebApp.initData`, verified server-side. */
export type TelegramInitDataAuthRequest = Schemas['InitDataRequest'];

/** `POST /auth/telegram/init-data` response. */
export type TelegramInitDataAuthResponse = SessionResponse;

/** `GET /api/v1/auth/config`. */
export type AuthConfig = Schemas['AuthConfigResponse'];

/** `POST /auth/telegram/login-widget` body: the fields Telegram's Login Widget passes to onauth. */
export type TelegramLoginWidgetPayload = Schemas['LoginWidgetRequest'];

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

// -- Delivery zones (public) ------------------------------------------------------------------

/** A Tashkent district (`tuman`); zones are matched by district, never by geocoding. */
export type District = Schemas['District'];

export type DistrictCode = District['code'];

/** Hours are `HH:MM` in Asia/Tashkent; money is integer UZS. */
export type DeliveryZone = Schemas['DeliveryZonePublic'];

/** `GET /api/v1/delivery/zones`: active zones only. */
export type DeliveryZoneList = Schemas['DeliveryZoneList'];

// -- Checkout & orders (session required; writes also CSRF) -----------------------------------

/** `POST /api/v1/checkout/quote` body. */
export type CheckoutQuoteRequest = Schemas['CheckoutQuoteRequest'];

/**
 * Server-computed quote. Problems are reported in `issues` / `can_place_order` rather than as
 * errors; send `total_uzs` back as `expected_total_uzs` when placing the order.
 */
export type CheckoutQuote = Schemas['CheckoutQuote'];

export type CheckoutQuoteIssue = CheckoutQuote['issues'][number];

export type DeliveryAddress = Schemas['DeliveryAddress'];

/** `POST /api/v1/orders` body; needs an `Idempotency-Key` header (16-128 of `[A-Za-z0-9_-]`). */
export type CreateOrderRequest = Schemas['CreateOrderRequest'];

export type OrderLine = Schemas['OrderLine'];

export type OrderAddress = Schemas['OrderAddress'];

export type OrderStatusChange = Schemas['OrderStatusChange'];

/** The customer's view of one of their orders. */
export type OrderDetail = Schemas['OrderDetail'];

export type OrderSummary = Schemas['OrderSummary'];

/** `GET /api/v1/orders` and `GET /api/v1/admin/orders`. */
export type OrderPage = Schemas['OrderPage'];

/** `POST /api/v1/orders/{id}/cancel` body. */
export type CancelOrderRequest = Schemas['CancelOrderRequest'];

// -- Back office (operator / admin role; writes also CSRF) -------------------------------------

export type AdminStatusChange = Schemas['AdminStatusChange'];

export type AdminOrderDetail = Schemas['AdminOrderDetail'];

/** `PATCH /api/v1/admin/orders/{id}/status` body. */
export type OrderStatusUpdateRequest = Schemas['OrderStatusUpdateRequest'];

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
  'district_not_served',
  'cart_empty',
  'below_min_order',
  'price_changed',
  'idempotency_key_conflict',
  'order_not_found',
  'order_not_cancellable',
  'invalid_status_transition',
  'order_status_conflict',
  'too_many_open_orders',
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
