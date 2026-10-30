import type { ProductSort, ProductUnit } from '@muniramarket/contracts';

/**
 * Shape every dictionary must satisfy. `uz.ts` and `ru.ts` are both typed as `Dictionary`, so a
 * missing or extra key in either file is a compile-time error.
 *
 * Strings may contain `{name}` placeholders, filled with `formatMessage`. Both languages must use
 * the same placeholders (checked in `index.test.ts`).
 */
export interface Dictionary {
  meta: {
    title: string;
    description: string;
  };
  nav: {
    home: string;
    cart: string;
    search: string;
    mainNavigation: string;
  };
  home: {
    title: string;
    tagline: string;
    categoriesHeading: string;
    newestHeading: string;
  };
  search: {
    label: string;
    placeholder: string;
    submit: string;
    heading: string;
    /** `{query}` */
    resultsFor: string;
    /** `{min}` */
    tooShort: string;
    noResults: string;
    noResultsHint: string;
  };
  catalog: {
    categoryLabel: string;
    subcategories: string;
    sortLabel: string;
    sort: Record<ProductSort, string>;
    /** `{count}` */
    productsCount: string;
    emptyCategory: string;
    pagination: {
      label: string;
      previous: string;
      next: string;
      /** `{page}`, `{total}` */
      position: string;
    };
  };
  product: {
    sku: string;
    brand: string;
    description: string;
    category: string;
    inStock: string;
    outOfStock: string;
    /** `{count}` */
    lowStock: string;
    priceCurrentLabel: string;
    priceOldLabel: string;
    quantity: string;
    decrease: string;
    increase: string;
    addToCart: string;
    adding: string;
    added: string;
    viewCart: string;
    /** `{count}` */
    maxPerOrder: string;
    errors: {
      productInactive: string;
      /** `{available}` */
      insufficientStock: string;
      cartLimit: string;
      generic: string;
    };
  };
  cart: {
    title: string;
    loading: string;
    empty: string;
    emptyHint: string;
    continueShopping: string;
    /** `{count}` */
    itemCount: string;
    subtotal: string;
    total: string;
    remove: string;
    issueInactive: string;
    /** `{available}` */
    issueInsufficientStock: string;
    issuesNote: string;
    checkoutSoon: string;
    loadFailed: string;
    updateFailed: string;
    /** `{available}` */
    updateInsufficientStock: string;
    retry: string;
  };
  auth: {
    checking: string;
    /** Browser without Telegram login: how to use the cart. */
    openInTelegram: string;
    /** Mini App, session could not be established. */
    miniAppFailed: string;
    retry: string;
    loginHeading: string;
    loginWidgetHint: string;
    accountBlocked: string;
    rateLimited: string;
    serviceUnavailable: string;
    logout: string;
    /** `{name}` */
    signedInAs: string;
    callbackSigningIn: string;
    callbackFailed: string;
    callbackBack: string;
  };
  units: Record<ProductUnit, string>;
  errors: {
    title: string;
    message: string;
    retry: string;
    notFoundTitle: string;
    notFoundMessage: string;
    backHome: string;
  };
  offline: {
    banner: string;
  };
  status: {
    label: string;
    telegram: string;
    browser: string;
  };
  language: {
    label: string;
    uz: string;
    ru: string;
  };
}
