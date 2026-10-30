import type {
  Locale,
  OrderStatus,
  PaymentMethod,
  ProductUnit,
  UserRole,
} from '@muniramarket/contracts';

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
    logout: string;
    language: { label: string; names: Record<Locale, string> };
  };
  auth: {
    checking: string;
    retry: string;
    signInTitle: string;
    signInHint: string;
    notConfiguredTitle: string;
    notConfiguredMessage: string;
    configFailed: string;
    accessDeniedTitle: string;
    accessDeniedMessage: string;
    accountBlocked: string;
    rateLimited: string;
    serviceUnavailable: string;
    sessionFailed: string;
    callbackSigningIn: string;
    callbackFailed: string;
    callbackBack: string;
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
}
