import type {
  Locale,
  OrderStatus,
  PaymentMethod,
  ProductUnit,
  TelegramOidcFailureStatus,
  UserRole,
} from '@muniramarket/contracts';
import type { AuditDict } from './sections/audit';
import type { CategoriesDict } from './sections/categories';
import type { CsvDict } from './sections/csv';
import type { DashboardDict } from './sections/dashboard';
import type { ProductsDict } from './sections/products';
import type {
  ApiErrorsDict,
  CommonDict,
  NavDict,
  PermissionDict,
  ValidationDict,
} from './sections/shared';
import type { SlotsDict } from './sections/slots';
import type { UsersDict } from './sections/users';
import type { ZonesDict } from './sections/zones';

/**
 * Shape every dictionary must satisfy. `uz.ts` and `ru.ts` are both typed as `Dictionary`, so a
 * missing or extra key in either file is a compile-time error. Strings with `{name}` placeholders
 * go through `formatMessage` (`../format.ts`).
 */
export interface Dictionary {
  meta: {
    title: string;
    description: string;
  };
  header: {
    appName: string;
    /** Small tag under the logo that marks the back office ("Admin panel"). */
    brandTag: string;
    logout: string;
    language: { label: string; names: Record<Locale, string> };
  };
  auth: {
    checking: string;
    retry: string;
    signInTitle: string;
    signInHint: string;
    /** The "Sign in with Telegram" button. */
    loginButton: string;
    /** Button label while the sign-in is starting (before the browser leaves for Telegram). */
    loginStarting: string;
    /** Inline error: the sign-in could not be started (generic). */
    loginStartFailed: string;
    notConfiguredTitle: string;
    notConfiguredMessage: string;
    configFailed: string;
    accessDeniedTitle: string;
    accessDeniedMessage: string;
    accountBlocked: string;
    rateLimited: string;
    serviceUnavailable: string;
    sessionFailed: string;
    /** `/<locale>/auth/telegram`: heading when Telegram sign-in did not complete. */
    callbackTitle: string;
    /** Message per `?status=` of the sign-in failure page (unknown values use `failed`). */
    callbackStatus: Record<TelegramOidcFailureStatus, string>;
    callbackBack: string;
    /** Button that starts a new sign-in after a failure. */
    tryAgain: string;
    /** `{code}`: the short request id ("support code") of a failed request. */
    supportCode: string;
    /** What to do with the support code. */
    supportCodeHint: string;
    /** Short line under the sign-in card: who may use this panel. */
    staffOnly: string;
  };
  orders: {
    title: string;
    filterLabel: string;
    filterAll: string;
    loading: string;
    empty: string;
    emptyFiltered: string;
    columns: { number: string; status: string; items: string; total: string; created: string };
    pagination: { label: string; previous: string; next: string; pageOf: string };
  };
  order: {
    back: string;
    title: string;
    notFoundTitle: string;
    notFoundMessage: string;
    loading: string;
    createdAt: string;
    deliverySlot: string;
    payment: string;
    items: { title: string; sku: string };
    totals: { subtotal: string; delivery: string; total: string };
    recipient: { title: string; name: string; phone: string };
    address: {
      title: string;
      district: string;
      street: string;
      house: string;
      apartment: string;
      entrance: string;
      floor: string;
      landmark: string;
    };
    comment: string;
    cancelReason: string;
    timeline: { title: string; created: string; reason: string };
    actions: { title: string; none: string; cancel: string; working: string };
    cancelDialog: {
      title: string;
      description: string;
      reasonLabel: string;
      reasonInvalid: string;
      confirm: string;
      dismiss: string;
    };
    notices: { conflict: string; updated: string };
    errors: { invalidTransition: string; failed: string };
  };
  status: Record<OrderStatus, string>;
  /** Label of the button that moves an order *to* the given status. */
  actions: Record<OrderStatus, string>;
  roles: Record<UserRole, string>;
  payment: Record<PaymentMethod, string>;
  units: Record<ProductUnit, string>;
  errors: {
    title: string;
    message: string;
    retry: string;
    forbidden: string;
    rateLimited: string;
    serviceUnavailable: string;
  };
  nav: NavDict;
  common: CommonDict;
  permission: PermissionDict;
  validation: ValidationDict;
  apiErrors: ApiErrorsDict;
  dashboard: DashboardDict;
  products: ProductsDict;
  categories: CategoriesDict;
  csv: CsvDict;
  zones: ZonesDict;
  slots: SlotsDict;
  users: UsersDict;
  audit: AuditDict;
}
