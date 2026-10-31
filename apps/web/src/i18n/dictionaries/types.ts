import type { OrderStatus, PaymentMethod, ProductSort, ProductUnit } from '@muniramarket/contracts';

/**
 * Noun forms by CLDR plural category. Russian needs `one` / `few` / `many`; Uzbek uses the same
 * text for every category. `{count}` is filled by `formatPlural`.
 */
export interface PluralForms {
  one: string;
  few: string;
  many: string;
  other: string;
}

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
    /** "My orders". */
    orders: string;
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
      /** The API asked us to wait; the add button stays disabled for as long as it said. */
      rateLimited: string;
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
    /** Checkout button; the Telegram MainButton appends the total. */
    checkout: string;
    loadFailed: string;
    updateFailed: string;
    /** `{available}` */
    updateInsufficientStock: string;
    /** The API asked us to wait; the controls are disabled for as long as it said. */
    updateRateLimited: string;
    retry: string;
  };
  checkout: {
    title: string;
    loading: string;
    loadFailed: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    toCatalog: string;
    /**
     * Shown instead of the empty cart when an attempt that did not get its answer (a timeout, then
     * a reload) turns out to have placed the order.
     */
    recovered: {
      title: string;
      /** `{number}` */
      hint: string;
      action: string;
    };
    backToCart: string;
    optional: string;
    sections: {
      delivery: string;
      recipient: string;
      payment: string;
      comment: string;
      summary: string;
    };
    labels: {
      district: string;
      street: string;
      house: string;
      apartment: string;
      entrance: string;
      floor: string;
      landmark: string;
      recipientName: string;
      recipientPhone: string;
      comment: string;
    };
    districtPlaceholder: string;
    /** Option group label. `{zone}`, `{fee}` */
    zoneGroup: string;
    noZones: string;
    /** `{time}` */
    zoneHours: string;
    /** `{min}` */
    zoneMinOrder: string;
    /** `{threshold}` */
    zoneFreeFrom: string;
    /** Shown when the zone is closed right now. `{time}` */
    closedNow: string;
    paymentHint: string;
    commentPlaceholder: string;
    /** `{count}`, `{max}` */
    charCounter: string;
    summary: {
      items: PluralForms;
      subtotal: string;
      delivery: string;
      free: string;
      pickDistrict: string;
      total: string;
      calculating: string;
      /** `{amount}` */
      freeRemaining: string;
      freeReached: string;
      /** `{min}` */
      belowMin: string;
      cartIssues: string;
      quoteFailed: string;
      districtNotServed: string;
      /** `{hint}` shown when the submit button is disabled because of the form. */
      fixFields: string;
    };
    submit: string;
    placing: string;
    confirmNewTotal: string;
    errors: {
      required: string;
      /** `{min}` */
      tooShort: string;
      /** `{max}` */
      tooLong: string;
      phone: string;
      singleLine: string;
      invalid: string;
      /** Summary shown above the form after a failed submit. */
      formInvalid: string;
    };
    /** Delivery time windows offered for zones that use them. */
    slots: {
      /** Section heading and the accessible name of the radio group. */
      title: string;
      /** Shown while a window is required. Also the reason the submit control is disabled. */
      hintRequired: string;
      hintOptional: string;
      today: string;
      tomorrow: string;
      /** Full weekday names, Sunday first (index = `Date#getUTCDay`). */
      weekdays: readonly [string, string, string, string, string, string, string];
      /** Accessible name of the row of day chips. */
      daysLabel: string;
      /** Compact hint under a day chip: how many windows can still be booked. `{count}` */
      dayFree: string;
      /** Screen-reader note on the day chip that holds the chosen window. */
      dayChosen: string;
      /** Describes the windows of the shown day when the chosen window is on another day. `{when}` */
      chosenElsewhere: string;
      /** Low availability on an option. `{count}` */
      remaining: PluralForms;
      /** Marks a window with no places left; it stays visible but cannot be chosen. */
      full: string;
      /** Every window is full (or there are none). */
      noneAvailable: string;
      /** Clears an optional choice. */
      clear: string;
      /** Label of the chosen window in the order summary. */
      summary: string;
      notice: {
        full: string;
        unavailable: string;
        required: string;
      };
    };
    failures: {
      priceChangedTitle: string;
      /** `{from}`, `{to}` */
      priceChanged: string;
      priceWas: string;
      priceNow: string;
      /** `{available}` */
      insufficientStock: string;
      insufficientStockUnknown: string;
      productInactive: string;
      cartEmpty: string;
      belowMin: string;
      districtNotServed: string;
      /** `{seconds}` */
      rateLimited: string;
      session: string;
      blocked: string;
      network: string;
      server: string;
      keyConflict: string;
      tooManyOpenOrders: string;
      goToOrders: string;
      unmapped: string;
      retry: string;
      /** Shown, visually only, beside `retry` while a rate-limit wait runs. `{seconds}` */
      retryCountdown: string;
      goToCart: string;
    };
  };
  orders: {
    title: string;
    loading: string;
    loadFailed: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    toCatalog: string;
    /** `{page}` */
    pageEmpty: string;
    firstPage: string;
    /** `{number}` */
    orderNumber: string;
    items: PluralForms;
    status: Record<OrderStatus, string>;
    payment: Record<PaymentMethod, string>;
    detail: {
      back: string;
      /** `{number}` */
      loadingLabel: string;
      placedTitle: string;
      placedHint: string;
      /** `?placed=found`: the retry was answered with the order an earlier attempt created. */
      foundTitle: string;
      foundHint: string;
      notFoundTitle: string;
      notFoundMessage: string;
      timeline: string;
      /** Marks the latest entry of the timeline. */
      current: string;
      itemsHeading: string;
      /** `{quantity}`, `{price}`, `{unit}` */
      lineBreakdown: string;
      subtotal: string;
      deliveryFee: string;
      free: string;
      total: string;
      deliveryHeading: string;
      /** The booked delivery window of the order. */
      slot: string;
      district: string;
      street: string;
      house: string;
      apartment: string;
      entrance: string;
      floor: string;
      landmark: string;
      recipientHeading: string;
      name: string;
      phone: string;
      paymentHeading: string;
      commentHeading: string;
      cancelReasonHeading: string;
      cancelledNotice: string;
      productRemoved: string;
    };
    cancel: {
      button: string;
      title: string;
      description: string;
      reasonLabel: string;
      quickLabel: string;
      quickReasons: {
        changedMind: string;
        wrongOrder: string;
        wrongAddress: string;
        foundElsewhere: string;
      };
      /** `{count}`, `{max}` */
      counter: string;
      confirm: string;
      cancelling: string;
      keep: string;
      close: string;
      /** `{min}` */
      tooShort: string;
      notCancellable: string;
      /** `{status}` */
      notCancellableNow: string;
      network: string;
      generic: string;
      done: string;
    };
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
