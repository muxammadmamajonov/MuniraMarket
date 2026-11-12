import type {
  OrderStatus,
  PaymentMethod,
  ProductSort,
  ProductUnit,
  TelegramOidcFailureStatus,
} from '@muniramarket/contracts';

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
    catalog: string;
    profile: string;
    /** Accessible name of the mobile bottom navigation. */
    tabBar: string;
    /** Cart tab name with the unit count, for screen readers. `{count}` */
    cartWithCount: string;
  };
  home: {
    title: string;
    tagline: string;
    categoriesHeading: string;
    /** Link from a home section heading to the full list (the catalog). */
    seeAll: string;
    newestHeading: string;
    /** Shown instead of the sections when the catalog has no categories and no products. */
    emptyTitle: string;
    emptyHint: string;
    /** How ordering works; only what the app really does. */
    info: {
      paymentTitle: string;
      paymentText: string;
    };
  };
  /** The storefront's delivery-district chooser. Never claims the location was detected. */
  delivery: {
    /** Visible label of the chooser once a district is set (small, above the name). */
    heading: string;
    /** Before a choice: the one line on the card, which is itself the button. */
    choosePrompt: string;
    change: string;
    sheetTitle: string;
    confirm: string;
    close: string;
    /** Legend of the district list in the sheet. */
    districtsLegend: string;
    /** Zones could not be loaded; catalog browsing still works. */
    unavailable: string;
    noZones: string;
    /** The remembered district is no longer served by any active zone. */
    previousUnavailable: string;
    /** Screen-reader announcement after a choice. `{district}` */
    saved: string;
  };
  /**
   * The map step (Yandex Maps): the customer moves the map under a centre pin, confirms with
   * "Deliver here", and the point is reverse-geocoded to a district and checked against the live
   * zones. Only the chosen district is remembered; the point itself is never stored.
   */
  map: {
    /** Button in the district sheet that opens the picker. */
    open: string;
    title: string;
    close: string;
    /** Accessible name of the map canvas, including how to pan it by keyboard. */
    canvasLabel: string;
    loading: string;
    /** No Maps key configured. */
    unavailableTitle: string;
    unavailableText: string;
    backToList: string;
    errorTitle: string;
    offlineTitle: string;
    errorText: string;
    retry: string;
    /** Beside the map before confirming: how the centre pin works. */
    hint: string;
    myLocation: string;
    locating: string;
    locationDenied: string;
    locationUnavailable: string;
    /** Accessible description of the centre pin. */
    pinLabel: string;
    /** The confirm button: reverse-geocode the pin and show the delivery result. */
    deliverHere: string;
    /** Opens the district list instead. */
    pickFromList: string;
    /** Back from a result to moving the map. */
    movePin: string;
    checking: string;
    /** `{district}` */
    servedTitle: string;
    zoneLabel: string;
    feeLabel: string;
    minOrderLabel: string;
    freeLabel: string;
    hoursLabel: string;
    /** Fee of 0. */
    free: string;
    /** `{amount}`: free delivery from this subtotal. */
    freeFrom: string;
    freeNever: string;
    openNow: string;
    closedNow: string;
    /** Badge next to a seeded `demo-` zone name. */
    demoBadge: string;
    demoNote: string;
    /** `{district}`: saves the district (only) and closes the map. */
    chooseDistrict: string;
    /** After a served result: the street address is typed at checkout; the point is not kept. */
    addressLater: string;
    /** `{district}` */
    notServedTitle: string;
    notServedNearby: string;
    notServedNoNearby: string;
    outsideTitle: string;
    outsideText: string;
    /** Lookup worked but named no district. */
    unknownTitle: string;
    unknownText: string;
    /** Lookup unavailable (key/plan, quota, network). Never implies we deliver. */
    lookupFailedTitle: string;
    lookupFailedText: string;
  };
  search: {
    label: string;
    /** Accessible name of the button that empties the search field. */
    clear: string;
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
    filterLabel: string;
    /** Toggle: only products that can be added to the cart now. */
    inStockOnly: string;
    /** Empty listing while the in-stock filter is on. */
    noneInStock: string;
    clearFilter: string;
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
    /** Heading of the product's details block (description, SKU, brand). */
    about: string;
    /** `{count}`: how much of this product the cart already holds (units of its own measure). */
    inCart: string;
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
    /** Short label of the add button on a product card. */
    addShort: string;
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
    /** Under the cart total: the delivery fee depends on the district, priced at checkout. */
    deliveryAtCheckout: string;
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
    loginHint: string;
    /** The "Sign in with Telegram" button. */
    loginButton: string;
    /** Button label while the sign-in is starting (before the browser leaves for Telegram). */
    loginStarting: string;
    /** Inline error: the sign-in could not be started (generic). */
    loginStartFailed: string;
    /** Inline error: Telegram sign-in is turned off for this site. */
    loginDisabled: string;
    accountBlocked: string;
    rateLimited: string;
    serviceUnavailable: string;
    /** Branded sign-in screen (cart, orders, profile, checkout). */
    screenTitle: string;
    screenSubtitle: string;
    benefits: readonly string[];
    /** Under the button: what signing in with Telegram does and does not do. */
    trust: string;
    /** The sign-in options could not be loaded. */
    configFailed: string;
    logout: string;
    /** `{name}` */
    signedInAs: string;
    /** `/<locale>/auth/telegram`: heading when Telegram sign-in did not complete. */
    callbackTitle: string;
    /** Message per `?status=` of the sign-in failure page (unknown values use `failed`). */
    callbackStatus: Record<TelegramOidcFailureStatus, string>;
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
  profile: {
    title: string;
    /** Section with the signed-in account. */
    accountHeading: string;
    /** Shown while the session is still being checked. */
    checking: string;
    anonymousTitle: string;
    /** Why to sign in; the sign-in control itself is the shared `SignInPrompt`. */
    anonymousText: string;
    ordersLink: string;
    ordersHint: string;
    languageHeading: string;
    /** Under the language choice: it is one setting shared with the bot. */
    languageHint: string;
    /** Inline error when the language could not be saved. */
    languageFailed: string;
    /** Under the name: the account is the Telegram account. */
    telegramAccount: string;
    settingsHeading: string;
    helpLink: string;
    helpHint: string;
    /** Footer line in the Mini App: no sign-out, the Telegram account is the session. */
    miniAppSession: string;
  };
  /** Account phone: shared from Telegram (Mini App) or via the bot (browser). Never typed. */
  phone: {
    heading: string;
    verified: string;
    notVerified: string;
    /** Why the number is needed; only what it is really used for. */
    why: string;
    share: string;
    update: string;
    updateHint: string;
    waiting: string;
    success: string;
    cancelled: string;
    timeout: string;
    checkAgain: string;
    /** Browser: open the bot, which asks for the number. */
    openBot: string;
    browserHint: string;
    /** Browser without a configured bot link. */
    openInTelegram: string;
    /** Telegram app too old for `requestContact`. */
    unsupported: string;
    checkoutTitle: string;
    checkoutText: string;
  };
  /** `/<locale>/help`: how the shop works; only what the app really does. */
  help: {
    title: string;
    intro: string;
    orderingTitle: string;
    orderingSteps: readonly string[];
    paymentTitle: string;
    paymentText: string;
    deliveryTitle: string;
    deliveryText: string;
    deliveryLink: string;
    statusTitle: string;
    statusText: string;
    phoneTitle: string;
    phoneText: string;
    languageTitle: string;
    languageText: string;
  };
  catalogPage: {
    title: string;
    /** Under the title: how many categories. `{count}` */
    count: string;
    emptyTitle: string;
    emptyHint: string;
  };
  language: {
    label: string;
    uz: string;
    ru: string;
    /** Short labels of the compact header switch. */
    uzShort: string;
    ruShort: string;
  };
}
